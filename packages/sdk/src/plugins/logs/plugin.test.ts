import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryEventStore } from '~/core/events/memory.js'
import { SessionFileStore } from '~/core/file-store/file-store.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import { SessionManager } from '~/core/sessions/session-manager.js'
import type { Session } from '~/core/sessions/session.js'
import { ToolExecutor } from '~/core/tools/executor.js'
import { silentLogger } from '~/lib/logger/logger.js'
import type { Platform, SessionLogPage, SessionLogStore } from '~/platform/index.js'
import { createNodePlatform } from '~/testing/node-platform.js'
import { createTestPreset } from '~/testing/preset-helpers.js'
import { logsPlugin } from './plugin.js'

/** The session's own lines land asynchronously; this only has to outlast their microtasks. */
const SETTLE_MS = 50

const ADDED = ['{"level":"info","message":"one"}', '{"level":"info","message":"two"}', '{"level":"info","message":"three"}']

/** What a host with a table for the log does, without the SQL. Cursor counts entries, not bytes. */
class MemorySessionLog implements SessionLogStore {
	readonly bySession = new Map<string, string[]>()
	/** Set by `read`, so a test can tell the store path from the file path. */
	reads = 0

	append(sessionId: string, line: string): void {
		const lines = this.bySession.get(sessionId) ?? []
		lines.push(line)
		this.bySession.set(sessionId, lines)
	}

	async read(sessionId: string, since: number): Promise<SessionLogPage> {
		this.reads++
		const all = this.bySession.get(sessionId) ?? []
		const lines = all.slice(since)
		return { lines, offset: Math.min(since, all.length) + lines.length }
	}

	async delete(sessionId: string): Promise<number> {
		const count = this.bySession.get(sessionId)?.length ?? 0
		this.bySession.delete(sessionId)
		return count
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `callPluginMethod` returns `unknown`; the output schema is the contract, so check it. */
function asPage(value: unknown): SessionLogPage {
	if (!isRecord(value) || typeof value.offset !== 'number' || !Array.isArray(value.lines)) {
		throw new Error(`not a log page: ${JSON.stringify(value)}`)
	}
	const lines: string[] = []
	for (const line of value.lines) {
		if (typeof line !== 'string') throw new Error(`not a log line: ${JSON.stringify(line)}`)
		lines.push(line)
	}
	return { lines, offset: value.offset }
}

/** Entries as written, with the fields two runs cannot share removed. */
function entries(lines: string[], sessionId: string): Record<string, unknown>[] {
	return lines.map((line) => {
		const parsed: unknown = JSON.parse(line)
		if (!isRecord(parsed)) throw new Error(`not a JSON object: ${line}`)
		const record: Record<string, unknown> = { ...parsed }
		expect(record.sessionId).toBe(sessionId)
		delete record.timestamp
		delete record.sessionId
		return record
	})
}

async function fileEntries(logPath: string, sessionId: string): Promise<Record<string, unknown>[]> {
	return entries((await readFile(logPath, 'utf-8')).split('\n').filter((line) => line.length > 0), sessionId)
}

const managers: SessionManager[] = []
const dirs: string[] = []

interface Host {
	session: Session
	manager: SessionManager
	/** Where the file sink would put the log, whether or not this host uses it. */
	logPath: string
	fs: Platform['fs']
	/** Adds lines the way the host's own sink would, so the cursor sees real growth. */
	add: (lines: string[]) => Promise<void>
}

/** Boot a session with only `logs` registered, over a file log or a store-backed one. */
async function bootHost(store?: SessionLogStore): Promise<Host> {
	const basePath = await mkdtemp(join(tmpdir(), 'roj-logs-'))
	dirs.push(basePath)
	const platform: Platform = { ...createNodePlatform(), sessionLog: store }
	const preset = createTestPreset({ id: 'logs-test', workspaceDir: join(basePath, 'workspace') })

	const manager = new SessionManager({
		eventStore: new MemoryEventStore(),
		llmProvider: MockLLMProvider.withFixedResponse({ content: 'ok', toolCalls: [] }),
		toolExecutor: new ToolExecutor(silentLogger),
		presets: new Map([[preset.id, preset]]),
		logger: silentLogger,
		basePath,
		dataFileStore: new SessionFileStore(basePath, undefined, false, platform.fs, 'session'),
		platform,
		systemPlugins: [logsPlugin],
	})
	managers.push(manager)

	const created = await manager.createSession(preset.id)
	if (!created.ok) throw new Error(`createSession failed: ${created.error.message}`)
	const session = created.value

	const logPath = join(basePath, 'sessions', String(session.id), 'session.log')
	return {
		session,
		manager,
		logPath,
		fs: platform.fs,
		add: async (lines) => {
			if (store === undefined) {
				await platform.fs.appendFile(logPath, lines.map((line) => `${line}\n`).join(''))
				return
			}
			for (const line of lines) store.append(String(session.id), line)
		},
	}
}

async function tail(session: Session, since?: number): Promise<SessionLogPage> {
	const result = await session.callPluginMethod('logs.tail', since === undefined ? {} : { since })
	if (!result.ok) throw new Error(`logs.tail failed: ${JSON.stringify(result.error)}`)
	return asPage(result.value)
}

afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.shutdown()
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

// Same expectations on both hosts: the cursor is opaque, so the only contract is
// that handing `offset` back returns exactly what arrived since.
const HOSTS: { name: string; store: () => SessionLogStore | undefined }[] = [
	{ name: 'session.log file', store: () => undefined },
	{ name: 'session-log store', store: () => new MemorySessionLog() },
]

for (const kind of HOSTS) {
	describe(`logs.tail over a ${kind.name}`, () => {
		test('returns everything logged so far from the default cursor', async () => {
			const host = await bootHost(kind.store())
			await Bun.sleep(SETTLE_MS)
			await host.add(ADDED)

			expect((await tail(host.session)).lines).toEqual(ADDED)
		})

		test('returns only what arrived after the cursor it was given', async () => {
			const host = await bootHost(kind.store())
			await Bun.sleep(SETTLE_MS)

			const first = await tail(host.session)
			await host.add(ADDED)

			const next = await tail(host.session, first.offset)
			expect(next.lines).toEqual(ADDED)
			expect(next.offset).toBeGreaterThan(first.offset)
		})

		test('holds the cursor when nothing new arrived', async () => {
			const host = await bootHost(kind.store())
			await Bun.sleep(SETTLE_MS)
			await host.add(ADDED)
			const caught = await tail(host.session)

			const idle = await tail(host.session, caught.offset)

			expect(idle.lines).toEqual([])
			expect(idle.offset).toBe(caught.offset)
		})

		test('rewinds a cursor left past the end instead of sticking', async () => {
			const host = await bootHost(kind.store())
			await Bun.sleep(SETTLE_MS)
			const caught = await tail(host.session)

			const beyond = await tail(host.session, caught.offset + 10_000)

			expect(beyond.lines).toEqual([])
			expect(beyond.offset).toBe(caught.offset)
		})
	})
}

describe('logs.tail on a host with a store', () => {
	test('reads the store and never touches the filesystem', async () => {
		const store = new MemorySessionLog()
		const host = await bootHost(store)
		await Bun.sleep(SETTLE_MS)
		await host.add(ADDED)

		const page = await tail(host.session)

		expect(page.lines).toEqual(ADDED)
		expect(store.reads).toBe(1)
		expect(await host.fs.exists(host.logPath)).toBe(false)
	})

	test('takes the session\'s own lines, the ones the file sink would have written', async () => {
		const store = new MemorySessionLog()
		const overFile = await bootHost()
		const overStore = await bootHost(store)

		await overFile.manager.shutdown()
		await overStore.manager.shutdown()
		await Bun.sleep(SETTLE_MS)

		const fromStore = entries(store.bySession.get(String(overStore.session.id)) ?? [], String(overStore.session.id))
		expect(fromStore.length).toBeGreaterThan(0)
		expect(fromStore).toEqual(await fileEntries(overFile.logPath, String(overFile.session.id)))
		expect(await overStore.fs.exists(overStore.logPath)).toBe(false)
	})

	test('drops every entry a session held on delete', async () => {
		const store = new MemorySessionLog()
		const host = await bootHost(store)
		await Bun.sleep(SETTLE_MS)
		await host.add(ADDED)

		const removed = await store.delete(String(host.session.id))

		expect(removed).toBeGreaterThanOrEqual(ADDED.length)
		expect((await tail(host.session)).lines).toEqual([])
	})
})
