import { Database } from 'bun:sqlite'
import type { SQLQueryBindings } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { isDomainEvent, SessionId } from '@roj-ai/sdk'
import type { DomainEvent } from '@roj-ai/sdk'
import { createSessionReaper } from './session-reaper.js'
import type { ReapableEventStore, ReapableFileSystem } from './session-reaper.js'
import { SqliteEventStore } from './sqlite-event-store.js'
import type { SqlCursorLike, SqlStorageHost, SqlStorageLike } from './sqlite-event-store.js'

function toBinding(value: unknown): SQLQueryBindings {
	if (
		value === null || typeof value === 'string' || typeof value === 'number'
		|| typeof value === 'bigint' || typeof value === 'boolean'
	) {
		return value
	}
	throw new Error(`Unsupported SQL binding: ${String(value)}`)
}

/** bun:sqlite standing in for a Durable Object's SQL surface. */
class FakeSqlStorage implements SqlStorageHost {
	private readonly db = new Database(':memory:')

	readonly sql: SqlStorageLike = {
		exec: <Row extends object>(query: string, ...bindings: unknown[]): SqlCursorLike<Row> => {
			const rows = this.db.query<Row, SQLQueryBindings[]>(query).all(...bindings.map(toBinding))
			return { toArray: () => rows }
		},
	}
}

/** Records what was removed instead of holding a tree — the reaper only ever calls rm. */
class FakeFileSystem implements ReapableFileSystem {
	readonly removed: string[] = []
	failOn: string | null = null
	/** Lets a test land a concurrent write inside the one long await a reap has. */
	onRm: ((path: string) => Promise<void>) | null = null

	async rm(path: string): Promise<void> {
		await this.onRm?.(path)
		if (this.failOn === path) throw new Error(`EIO: ${path}`)
		this.removed.push(path)
	}
}

function makeEvent(sessionId: SessionId, type: string, payload: Record<string, unknown> = {}, timestamp = 1000): DomainEvent {
	const event: unknown = { sessionId, timestamp, type, ...payload }
	// DomainEvent is branded; the SDK's own guard is the only honest way to produce one.
	if (!isDomainEvent(event)) throw new Error('constructed event is not a DomainEvent')
	return event
}

const WORKSPACE_ROOT = '/workspace'
const DATA_DIR = '/data'

describe('createSessionReaper', () => {
	let storage: FakeSqlStorage
	let store: SqliteEventStore
	let fs: FakeFileSystem
	let nextId: number

	beforeEach(() => {
		storage = new FakeSqlStorage()
		store = new SqliteEventStore(storage)
		fs = new FakeFileSystem()
		nextId = 0
	})

	/** Seeds a session at `workspaceDir`, closed unless told otherwise. */
	async function seed(options: { closed?: boolean; workspaceDir?: string | null; closedAt?: number } = {}): Promise<SessionId> {
		nextId++
		const sessionId = SessionId(`01900000-0000-7000-8000-00000000000${nextId}`)
		const workspaceDir = options.workspaceDir === undefined ? `${WORKSPACE_ROOT}/${sessionId}` : options.workspaceDir
		await store.appendBatch(sessionId, [
			makeEvent(sessionId, 'session_created', { presetId: 'test', ...(workspaceDir === null ? {} : { workspaceDir }) }),
			makeEvent(sessionId, 'agent_spawned', { agentId: 'agent-1', definitionName: 'orchestrator', parentId: null }),
		])
		if (options.closed !== false) {
			await store.append(sessionId, makeEvent(sessionId, 'session_closed', {}, options.closedAt ?? 1000))
		}
		return sessionId
	}

	test('removes a closed session workspace and keeps its events', async () => {
		const sessionId = await seed()
		const reaper = createSessionReaper({ eventStore: store, fs })

		const report = await reaper.reap()

		expect(fs.removed).toEqual([`${WORKSPACE_ROOT}/${sessionId}`])
		expect(report.reaped).toHaveLength(1)
		expect(report.reaped[0]).toMatchObject({ sessionId, removedWorkspace: true, removedEvents: 0 })
		expect(await store.load(sessionId)).toHaveLength(3)
	})

	test('does not walk a session whose files it already took', async () => {
		await seed()
		const reaper = createSessionReaper({ eventStore: store, fs, dataDir: DATA_DIR })

		await reaper.reap()
		const second = await reaper.reap()

		expect(second.skipped.alreadyReaped).toBe(1)
		expect(second.reaped).toEqual([])
		// Two removals, not four: the second sweep touched the filesystem not at all.
		expect(fs.removed).toHaveLength(2)
	})

	test('still drops the log of a session whose files already went', async () => {
		const sessionId = await seed()
		const reaper = createSessionReaper({ eventStore: store, fs })

		await reaper.reap()
		const second = await reaper.reap({ events: true })

		expect(second.reaped[0]).toMatchObject({ removedWorkspace: false, removedEvents: 3 })
		expect(fs.removed).toHaveLength(1)
		expect(await store.exists(sessionId)).toBe(false)
	})

	test('keeps the age of a session it stamped', async () => {
		await seed({ closedAt: 1000 })
		const reaper = createSessionReaper({ eventStore: store, fs })

		await reaper.reap()

		// A stamp that restated lastActivityAt as "now" would restart the grace period.
		const listed = await store.listSessionsWithMetadata({ status: 'closed' })
		expect(listed.sessions[0]?.lastActivityAt).toBe(1000)
	})

	test('drops the event log only when asked', async () => {
		const sessionId = await seed()
		const reaper = createSessionReaper({ eventStore: store, fs })

		const report = await reaper.reap({ events: true })

		expect(report.reaped[0]?.removedEvents).toBe(3)
		expect(await store.exists(sessionId)).toBe(false)
		expect(await store.getMetadata(sessionId)).toBeNull()
	})

	test('removes the session data directory when a dataDir is configured', async () => {
		const sessionId = await seed()
		const reaper = createSessionReaper({ eventStore: store, fs, dataDir: DATA_DIR })

		await reaper.reap()

		expect(fs.removed).toEqual([`${WORKSPACE_ROOT}/${sessionId}`, `${DATA_DIR}/sessions/${sessionId}`])
	})

	test('never touches a session that is not closed', async () => {
		const live = await seed({ closed: false })
		const reaper = createSessionReaper({ eventStore: store, fs })

		const report = await reaper.reap({ events: true })

		expect(report.closed).toBe(0)
		expect(report.reaped).toEqual([])
		expect(fs.removed).toEqual([])
		expect(await store.load(live)).toHaveLength(2)
	})

	test('never touches a session reopened between the listing and the re-read', async () => {
		const sessionId = await seed()
		// The listing is a snapshot; this lands a reopen just after it was taken.
		let reopened = false
		const racing: ReapableEventStore = {
			listSessionsWithMetadata: (options) => store.listSessionsWithMetadata(options),
			getMetadata: async (id) => {
				if (!reopened) {
					reopened = true
					await store.append(sessionId, makeEvent(sessionId, 'session_reopened', {}, 2000))
				}
				return store.getMetadata(id)
			},
			updateMetadata: (id, update) => store.updateMetadata(id, update),
			loadRange: (id, options) => store.loadRange(id, options),
			deleteSession: (id) => store.deleteSession(id),
		}
		const reaper = createSessionReaper({ eventStore: racing, fs })

		const report = await reaper.reap({ events: true })

		expect(report.skipped.reopened).toBe(1)
		expect(fs.removed).toEqual([])
		expect(await store.exists(sessionId)).toBe(true)
	})

	test('keeps the event log when a reopen lands while the workspace is removed', async () => {
		const sessionId = await seed()
		fs.onRm = async () => {
			fs.onRm = null
			await store.append(sessionId, makeEvent(sessionId, 'session_reopened', {}, 2000))
		}
		const reaper = createSessionReaper({ eventStore: store, fs })

		const report = await reaper.reap({ events: true })

		expect(report.skipped.reopened).toBe(1)
		expect(report.reaped[0]).toMatchObject({ removedWorkspace: true, removedEvents: 0 })
		expect(await store.exists(sessionId)).toBe(true)
	})

	test('never touches a session the host protects', async () => {
		const sessionId = await seed()
		const reaper = createSessionReaper({ eventStore: store, fs, isProtected: (id) => id === sessionId })

		const report = await reaper.reap({ events: true })

		expect(report.skipped.protectedByHost).toBe(1)
		expect(fs.removed).toEqual([])
		expect(await store.exists(sessionId)).toBe(true)
	})

	test('never removes a workspace directory the session does not own alone', async () => {
		const sessionId = await seed({ workspaceDir: '/workspace/shared' })
		const reaper = createSessionReaper({ eventStore: store, fs })

		const report = await reaper.reap({ events: true })

		expect(report.skipped.sharedWorkspace).toBe(1)
		expect(fs.removed).toEqual([])
		// The rows stay too, or nothing would name the directory again.
		expect(await store.exists(sessionId)).toBe(true)
	})

	test('reaps a session that never had a workspace of its own', async () => {
		const sessionId = await seed({ workspaceDir: null })
		const reaper = createSessionReaper({ eventStore: store, fs })

		const report = await reaper.reap({ events: true })

		expect(fs.removed).toEqual([])
		expect(report.reaped[0]).toMatchObject({ workspaceDir: null, removedWorkspace: false, removedEvents: 3 })
		expect(await store.exists(sessionId)).toBe(false)
	})

	test('honours minAgeMs against the last activity', async () => {
		await seed({ closedAt: Date.now() })
		const reaper = createSessionReaper({ eventStore: store, fs })

		const report = await reaper.reap({ minAgeMs: 60_000 })

		expect(report.skipped.tooYoung).toBe(1)
		expect(fs.removed).toEqual([])
	})

	test('caps a sweep at limit and takes the oldest first', async () => {
		const oldest = await seed({ closedAt: 1000 })
		await seed({ closedAt: 2000 })
		await seed({ closedAt: 3000 })
		const reaper = createSessionReaper({ eventStore: store, fs })

		const report = await reaper.reap({ limit: 1 })

		expect(report.closed).toBe(3)
		expect(report.reaped.map((entry) => entry.sessionId)).toEqual([oldest])
		expect(report.skipped.overLimit).toBe(2)
	})

	test('dryRun reports what would go and removes nothing', async () => {
		const sessionId = await seed()
		const reaper = createSessionReaper({ eventStore: store, fs })

		const report = await reaper.reap({ events: true, dryRun: true })

		expect(report.dryRun).toBe(true)
		expect(report.reaped[0]).toMatchObject({ sessionId, removedWorkspace: false, removedEvents: 0 })
		expect(fs.removed).toEqual([])
		expect(await store.exists(sessionId)).toBe(true)
	})

	test('keeps the event log when the workspace removal fails', async () => {
		const sessionId = await seed()
		fs.failOn = `${WORKSPACE_ROOT}/${sessionId}`
		const reaper = createSessionReaper({ eventStore: store, fs })

		const report = await reaper.reap({ events: true })

		expect(report.reaped[0]?.error).toContain('EIO')
		expect(await store.exists(sessionId)).toBe(true)
	})
})
