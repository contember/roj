import { generateTestAgentId } from '~/core/agents/schema.js'
import { agentEvents } from '~/core/agents/state.js'
import type { agentEvents as AgentEventsType } from '~/core/agents/state.js'
import type { DomainEvent, FactoryEventType } from '~/core/events/types.js'
import { generateSessionId, SessionId, sessionMetadataSchema } from '~/core/sessions/schema.js'
import type { SessionMetadata } from '~/core/sessions/schema.js'
import { isSessionCreatedEvent, sessionEvents } from '~/core/sessions/state.js'

type AgentEvent = FactoryEventType<typeof AgentEventsType>
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withSessionId } from '~/core/events/test-helpers.js'
import type { Logger } from '~/lib/logger/logger.js'
import type { FileSystem } from '~/platform/fs.js'
import { createNodeFileSystem } from '~/testing/node-platform.js'
import { EventStoreError } from './event-store.js'
import { FileEventStore } from './file.js'

const TEST_BASE_PATH = join(import.meta.dir, '.test-data')

/** Wraps a FileSystem and counts meta.json reads, so cache hits are observable without timing. */
function countingFileSystem(inner: FileSystem): { fs: FileSystem; metaReads: () => number } {
	let metaReads = 0

	function readFile(path: string): Promise<Buffer>
	function readFile(path: string, encoding: 'utf-8' | 'utf8'): Promise<string>
	function readFile(path: string, encoding?: 'utf-8' | 'utf8'): Promise<Buffer | string> {
		if (path.endsWith('meta.json')) metaReads++
		return encoding === undefined ? inner.readFile(path) : inner.readFile(path, encoding)
	}

	return { fs: { ...inner, readFile }, metaReads: () => metaReads }
}

/** Write a raw meta.json for a session directory, bypassing the store. */
async function writeRawMetadata(sessionDirName: string, content: string): Promise<void> {
	const dir = join(TEST_BASE_PATH, 'sessions', sessionDirName, '.events')
	await mkdir(dir, { recursive: true })
	await writeFile(join(dir, 'meta.json'), content)
}

/** A store that has never read this data root, so on-disk state is a cold read. */
function coldStore(fs: FileSystem = createNodeFileSystem()): FileEventStore {
	return new FileEventStore(TEST_BASE_PATH, fs)
}

async function createSession(store: FileEventStore, sessionId: SessionId): Promise<void> {
	await store.append(
		sessionId,
		withSessionId(
			sessionId,
			sessionEvents.create('session_created', {
				presetId: 'test-preset',
			}),
		),
	)
}

/**
 * Holds the first meta.json read open: the bytes are captured up front and only
 * handed back on release(), so a write can be made to land inside the read window.
 */
function holdFirstMetaRead(inner: FileSystem): { fs: FileSystem; captured: Promise<void>; release: () => void } {
	let openGate: () => void = () => {}
	const gate = new Promise<void>((resolve) => {
		openGate = () => resolve()
	})
	let signalCaptured: () => void = () => {}
	const captured = new Promise<void>((resolve) => {
		signalCaptured = () => resolve()
	})
	let held = false

	function readFile(path: string): Promise<Buffer>
	function readFile(path: string, encoding: 'utf-8' | 'utf8'): Promise<string>
	function readFile(path: string, encoding?: 'utf-8' | 'utf8'): Promise<Buffer | string> {
		const pending = encoding === undefined ? inner.readFile(path) : inner.readFile(path, encoding)
		if (held || !path.endsWith('meta.json')) return pending

		held = true
		return pending.then(async (result) => {
			signalCaptured()
			await gate
			return result
		})
	}

	return { fs: { ...inner, readFile }, captured, release: () => openGate() }
}

/** Fails every meta.json read the way a bad permission does — an error that is not ENOENT. */
function denyingFileSystem(inner: FileSystem): FileSystem {
	function readFile(path: string): Promise<Buffer>
	function readFile(path: string, encoding: 'utf-8' | 'utf8'): Promise<string>
	function readFile(path: string, encoding?: 'utf-8' | 'utf8'): Promise<Buffer | string> {
		if (path.endsWith('meta.json')) {
			return Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))
		}
		return encoding === undefined ? inner.readFile(path) : inner.readFile(path, encoding)
	}

	return { ...inner, readFile }
}

/** Every other test runs on the silent logger, so what the store reports is otherwise unverified. */
function recordingLogger(): { logger: Logger; warns: string[]; errors: string[] } {
	const warns: string[] = []
	const errors: string[] = []
	const logger: Logger = {
		debug: () => {},
		info: () => {},
		warn: (message) => {
			warns.push(message)
		},
		error: (message) => {
			errors.push(message)
		},
		child: () => logger,
		level: 'debug',
	}

	return { logger, warns, errors }
}

/** Reads meta.json straight from disk, so what a restart would see is assertable. */
async function readPersistedMetadata(sessionDirName: string): Promise<SessionMetadata> {
	const raw = await readFile(join(TEST_BASE_PATH, 'sessions', sessionDirName, '.events', 'meta.json'), 'utf-8')
	return sessionMetadataSchema.parse(JSON.parse(raw))
}

async function appendAgentSpawned(store: FileEventStore, sessionId: SessionId): Promise<void> {
	await store.append(
		sessionId,
		withSessionId(
			sessionId,
			agentEvents.create('agent_spawned', {
				agentId: generateTestAgentId(),
				definitionName: 'test-agent',
				parentId: null,
			}),
		),
	)
}

describe('FileEventStore', () => {
	let store: FileEventStore
	let testSessionId: SessionId

	beforeEach(async () => {
		// Clean up and recreate test directory
		await rm(TEST_BASE_PATH, { recursive: true, force: true })
		await mkdir(TEST_BASE_PATH, { recursive: true })
		store = new FileEventStore(TEST_BASE_PATH, createNodeFileSystem())
		testSessionId = generateSessionId()
	})

	afterEach(async () => {
		// Clean up test directory
		await rm(TEST_BASE_PATH, { recursive: true, force: true })
	})

	describe('append', () => {
		test('appends single event to JSONL file', async () => {
			const event = withSessionId(
				testSessionId,
				sessionEvents.create('session_created', {
					presetId: 'test-preset',
				}),
			)

			await store.append(testSessionId, event)

			const loaded = await store.load(testSessionId)
			expect(loaded).toHaveLength(1)
			expect(loaded[0]).toMatchObject({
				type: 'session_created',
				sessionId: testSessionId,
				presetId: 'test-preset',
			})
		})

		test('auto-creates directory if it does not exist', async () => {
			const event = withSessionId(
				testSessionId,
				sessionEvents.create('session_created', {
					presetId: 'test-preset',
				}),
			)

			await store.append(testSessionId, event)

			const rojDir = join(TEST_BASE_PATH, 'sessions', testSessionId, '.events')
			const entries = await readdir(rojDir)
			expect(entries).toContain('events.jsonl')
		})

		test('appends multiple events sequentially', async () => {
			const event1 = withSessionId(
				testSessionId,
				sessionEvents.create('session_created', {
					presetId: 'test-preset',
				}),
			)

			const agentId = generateTestAgentId()
			const event2 = withSessionId(
				testSessionId,
				agentEvents.create('agent_spawned', {
					agentId,
					definitionName: 'test-agent',
					parentId: null,
				}),
			)

			await store.append(testSessionId, event1)
			await store.append(testSessionId, event2)

			const loaded = await store.load(testSessionId)
			expect(loaded).toHaveLength(2)
			expect(loaded[0]?.type).toBe('session_created')
			expect(loaded[1]?.type).toBe('agent_spawned')
		})
	})

	describe('appendBatch', () => {
		test('appends multiple events in a batch', async () => {
			const agentId = generateTestAgentId()
			const events: DomainEvent[] = [
				withSessionId(
					testSessionId,
					sessionEvents.create('session_created', {
						presetId: 'test-preset',
					}),
				),
				withSessionId(
					testSessionId,
					agentEvents.create('agent_spawned', {
						agentId,
						definitionName: 'test-agent',
						parentId: null,
					}),
				),
			]

			await store.appendBatch(testSessionId, events)

			const loaded = await store.load(testSessionId)
			expect(loaded).toHaveLength(2)
		})

		test('handles empty batch', async () => {
			await store.appendBatch(testSessionId, [])
			const loaded = await store.load(testSessionId)
			expect(loaded).toHaveLength(0)
		})

		test('auto-creates directory for batch', async () => {
			const events: DomainEvent[] = [
				withSessionId(
					testSessionId,
					sessionEvents.create('session_created', {
						presetId: 'test-preset',
					}),
				),
			]

			await store.appendBatch(testSessionId, events)

			const exists = await store.exists(testSessionId)
			expect(exists).toBe(true)
		})
	})

	describe('load', () => {
		test('returns empty array for non-existent session', async () => {
			const nonExistentId = generateSessionId()
			const loaded = await store.load(nonExistentId)
			expect(loaded).toEqual([])
		})

		test('loads events in correct order', async () => {
			const events: DomainEvent[] = []
			for (let i = 0; i < 5; i++) {
				events.push(withSessionId(
					testSessionId,
					sessionEvents.create('session_created', {
						presetId: `preset-${i}`,
					}),
				))
			}

			await store.appendBatch(testSessionId, events)
			const loaded = await store.load(testSessionId)

			expect(loaded).toHaveLength(5)
			for (let i = 0; i < 5; i++) {
				const event = loaded[i]
				if (isSessionCreatedEvent(event)) {
					expect(event.presetId).toBe(`preset-${i}`)
				}
			}
		})

		test('validates events with Zod schema', async () => {
			const event = withSessionId(
				testSessionId,
				sessionEvents.create('session_created', {
					presetId: 'test-preset',
				}),
			)

			await store.append(testSessionId, event)
			const loaded = await store.load(testSessionId)

			expect(loaded[0]).toMatchObject({
				type: 'session_created',
				sessionId: testSessionId,
				presetId: 'test-preset',
			})
		})
	})

	describe('exists', () => {
		test('returns false for non-existent session', async () => {
			const nonExistentId = generateSessionId()
			const exists = await store.exists(nonExistentId)
			expect(exists).toBe(false)
		})

		test('returns true for existing session', async () => {
			const event = withSessionId(
				testSessionId,
				sessionEvents.create('session_created', {
					presetId: 'test-preset',
				}),
			)

			await store.append(testSessionId, event)
			const exists = await store.exists(testSessionId)
			expect(exists).toBe(true)
		})
	})

	describe('listSessions', () => {
		test('returns empty array when no sessions exist', async () => {
			const sessions = await store.listSessions()
			expect(sessions).toEqual([])
		})

		test('returns all session IDs', async () => {
			const session1 = generateSessionId()
			const session2 = generateSessionId()
			const session3 = generateSessionId()

			await store.append(
				session1,
				withSessionId(
					session1,
					sessionEvents.create('session_created', {
						presetId: 'test',
					}),
				),
			)

			await store.append(
				session2,
				withSessionId(
					session2,
					sessionEvents.create('session_created', {
						presetId: 'test',
					}),
				),
			)

			await store.append(
				session3,
				withSessionId(
					session3,
					sessionEvents.create('session_created', {
						presetId: 'test',
					}),
				),
			)

			const sessions = await store.listSessions()
			expect(sessions).toHaveLength(3)
			expect(sessions).toContain(session1)
			expect(sessions).toContain(session2)
			expect(sessions).toContain(session3)
		})

		test('skips directories that cannot be session ids', async () => {
			await createSession(store, testSessionId)
			// A legacy session directory that listSessionsWithMetadata drops as well.
			await writeRawMetadata(
				'legacy.session',
				JSON.stringify({
					sessionId: 'legacy.session',
					presetId: 'test-preset',
					createdAt: 1,
					lastActivityAt: 2,
					status: 'active',
				}),
			)

			expect(await store.listSessions()).toEqual([testSessionId])
		})
	})

	describe('loadRange', () => {
		test('returns empty result for non-existent session', async () => {
			const nonExistentId = generateSessionId()
			const result = await store.loadRange(nonExistentId)
			expect(result.events).toEqual([])
			expect(result.fromIndex).toBe(-1)
			expect(result.toIndex).toBe(-1)
		})

		test('returns all events when no options provided', async () => {
			const event1 = withSessionId(
				testSessionId,
				sessionEvents.create('session_created', {
					presetId: 'test-preset',
				}),
			)
			const agentId = generateTestAgentId()
			const event2 = withSessionId(
				testSessionId,
				agentEvents.create('agent_spawned', {
					agentId,
					definitionName: 'test-agent',
					parentId: null,
				}),
			)

			await store.append(testSessionId, event1)
			await store.append(testSessionId, event2)

			const result = await store.loadRange(testSessionId)
			expect(result.events).toHaveLength(2)
			expect(result.fromIndex).toBe(0)
			expect(result.toIndex).toBe(1)
		})

		test('returns events after since index', async () => {
			await store.append(
				testSessionId,
				withSessionId(
					testSessionId,
					sessionEvents.create('session_created', {
						presetId: 'test-preset',
					}),
				),
			)

			// Add 9 more events (agent spawns)
			for (let i = 1; i < 10; i++) {
				await store.append(
					testSessionId,
					withSessionId(
						testSessionId,
						agentEvents.create('agent_spawned', {
							agentId: generateTestAgentId(),
							definitionName: `agent-${i}`,
							parentId: null,
						}),
					),
				)
			}

			// Load events after index 7 (should get events 8 and 9)
			const result = await store.loadRange(testSessionId, { since: 7 })
			expect(result.events).toHaveLength(2)
			expect(result.fromIndex).toBe(8)
			expect(result.toIndex).toBe(9)
			const event0 = result.events[0] as AgentEvent
			const event1 = result.events[1] as AgentEvent
			if (event0?.type === 'agent_spawned') {
				expect(event0.definitionName).toBe('agent-8')
			}
			if (event1?.type === 'agent_spawned') {
				expect(event1.definitionName).toBe('agent-9')
			}
		})

		test('returns empty when since equals last index', async () => {
			const event = withSessionId(
				testSessionId,
				sessionEvents.create('session_created', {
					presetId: 'test-preset',
				}),
			)
			await store.append(testSessionId, event)

			const result = await store.loadRange(testSessionId, { since: 0 })
			expect(result.events).toEqual([])
			expect(result.fromIndex).toBe(-1)
			// toIndex still returns the actual last index for polling cursor
			expect(result.toIndex).toBe(0)
		})

		test('returns empty when since exceeds total events', async () => {
			const event = withSessionId(
				testSessionId,
				sessionEvents.create('session_created', {
					presetId: 'test-preset',
				}),
			)
			await store.append(testSessionId, event)

			const result = await store.loadRange(testSessionId, { since: 10 })
			expect(result.events).toEqual([])
			expect(result.fromIndex).toBe(-1)
			// toIndex still returns the actual last index for polling cursor
			expect(result.toIndex).toBe(0)
		})

		test('respects limit parameter', async () => {
			await store.append(
				testSessionId,
				withSessionId(
					testSessionId,
					sessionEvents.create('session_created', {
						presetId: 'test-preset',
					}),
				),
			)

			// Add 9 more events (agent spawns)
			for (let i = 1; i < 10; i++) {
				await store.append(
					testSessionId,
					withSessionId(
						testSessionId,
						agentEvents.create('agent_spawned', {
							agentId: generateTestAgentId(),
							definitionName: `agent-${i}`,
							parentId: null,
						}),
					),
				)
			}

			// Load max 3 events after index 5 → events at indices 6, 7, 8
			const result = await store.loadRange(testSessionId, { since: 5, limit: 3 })
			expect(result.events).toHaveLength(3)
			expect(result.fromIndex).toBe(6)
			expect(result.toIndex).toBe(8)
		})
	})

	describe('metadata resilience', () => {
		test('skips corrupt and legacy metadata instead of failing the listing', async () => {
			await createSession(store, testSessionId)

			// A legacy record whose id predates the strict session id pattern.
			await writeRawMetadata(
				'legacy.session',
				JSON.stringify({
					sessionId: 'legacy.session',
					presetId: 'test-preset',
					createdAt: 1,
					lastActivityAt: 2,
					status: 'active',
				}),
			)
			// A meta.json truncated by a non-atomic write.
			await writeRawMetadata('truncated-session', '{"sessionId":"truncated-sess')

			const counting = countingFileSystem(createNodeFileSystem())
			const cold = coldStore(counting.fs)
			const result = await cold.listSessionsWithMetadata()

			expect(result.sessions.map((s) => s.sessionId)).toEqual([testSessionId])
			expect(result.total).toBe(1)
			// The good records still load individually.
			expect(await cold.getMetadata(testSessionId)).toMatchObject({ sessionId: testSessionId })

			// Bad records are not re-read — and so not re-reported — on every poll.
			const reads = counting.metaReads()
			await cold.listSessionsWithMetadata()
			expect(counting.metaReads()).toBe(reads)
		})

		test('returns null for a session whose metadata cannot be parsed', async () => {
			await writeRawMetadata('broken-session', 'not json at all')

			expect(await coldStore().getMetadata(SessionId('broken-session'))).toBeNull()
		})
	})

	describe('metadata cache', () => {
		test('serves repeat metadata reads without re-reading meta.json', async () => {
			const sessionIds = [generateSessionId(), generateSessionId(), generateSessionId()]
			for (const sessionId of sessionIds) {
				await createSession(store, sessionId)
			}

			const counting = countingFileSystem(createNodeFileSystem())
			const cold = coldStore(counting.fs)

			const first = await cold.listSessionsWithMetadata()
			expect(first.total).toBe(3)
			// Cold start: one readdir plus one meta.json read per session.
			expect(counting.metaReads()).toBe(3)

			const second = await cold.listSessionsWithMetadata()
			await cold.getMetadata(sessionIds[0])

			expect(second.total).toBe(3)
			expect(counting.metaReads()).toBe(3)
		})

		test('reflects writes without going back to disk', async () => {
			await createSession(store, testSessionId)

			const counting = countingFileSystem(createNodeFileSystem())
			const cold = coldStore(counting.fs)
			await cold.listSessionsWithMetadata()
			expect(counting.metaReads()).toBe(1)

			await cold.updateMetadata(testSessionId, { name: 'renamed' })

			const result = await cold.listSessionsWithMetadata()
			expect(result.sessions[0]?.name).toBe('renamed')
			expect(counting.metaReads()).toBe(1)
		})

		test('drops sessions that disappeared from disk', async () => {
			const removedId = generateSessionId()
			await createSession(store, testSessionId)
			await createSession(store, removedId)
			expect((await store.listSessionsWithMetadata()).total).toBe(2)

			await rm(join(TEST_BASE_PATH, 'sessions', removedId), { recursive: true, force: true })

			const result = await store.listSessionsWithMetadata()
			expect(result.sessions.map((s) => s.sessionId)).toEqual([testSessionId])
			expect(await store.getMetadata(removedId)).toBeNull()
		})
	})

	describe('metadata coherence', () => {
		test('a write that lands during a slow read survives it', async () => {
			await createSession(store, testSessionId)
			await appendAgentSpawned(store, testSessionId)

			const held = holdFirstMetaRead(createNodeFileSystem())
			const cold = coldStore(held.fs)

			// The read holds the two-event record while two further events are appended.
			const slow = cold.getMetadata(testSessionId)
			await held.captured
			await appendAgentSpawned(cold, testSessionId)
			await appendAgentSpawned(cold, testSessionId)
			held.release()

			expect((await slow)?.metrics?.totalEvents).toBe(4)

			// The stale record must not become the base the next append counts from.
			await appendAgentSpawned(cold, testSessionId)
			expect(await store.load(testSessionId)).toHaveLength(5)
			expect((await readPersistedMetadata(testSessionId)).metrics?.totalEvents).toBe(5)
		})

		test('an unparseable meta.json lists the same from a warm store and a cold one', async () => {
			const brokenId = SessionId('incomplete-session')
			// Truncated by a non-atomic write, so the append below has no base to merge onto.
			await writeRawMetadata(brokenId, '{"sessionId":"incomplete-sess')

			const warm = coldStore()
			await appendAgentSpawned(warm, brokenId)

			const warmListing = await warm.listSessionsWithMetadata()
			const coldListing = await coldStore().listSessionsWithMetadata()

			expect(warmListing.sessions.map((s) => s.sessionId)).toEqual(coldListing.sessions.map((s) => s.sessionId))
			expect(warmListing.total).toBe(0)
			expect(await warm.getMetadata(brokenId)).toBeNull()
			expect(await coldStore().getMetadata(brokenId)).toBeNull()
		})

		test('re-reads metadata once a corrupt meta.json is repaired', async () => {
			const repairedId = SessionId('repaired-session')
			await writeRawMetadata(repairedId, 'not json at all')

			const recorded = recordingLogger()
			const cold = new FileEventStore(TEST_BASE_PATH, createNodeFileSystem(), recorded.logger)

			expect(await cold.getMetadata(repairedId)).toBeNull()
			expect(await cold.getMetadata(repairedId)).toBeNull()
			// Reported once while the bytes stay the same — that is what caching the verdict buys.
			expect(recorded.warns).toEqual(['Skipping unreadable session metadata'])

			await writeRawMetadata(
				repairedId,
				JSON.stringify({
					sessionId: repairedId,
					presetId: 'test-preset',
					createdAt: 1,
					lastActivityAt: 2,
					status: 'active',
				}),
			)

			expect(await cold.getMetadata(repairedId)).toMatchObject({ sessionId: repairedId })
		})

		test('reports an unreadable meta.json once, not on every poll', async () => {
			await createSession(store, testSessionId)

			const recorded = recordingLogger()
			const cold = new FileEventStore(TEST_BASE_PATH, denyingFileSystem(createNodeFileSystem()), recorded.logger)

			expect((await cold.listSessionsWithMetadata()).total).toBe(0)
			expect((await cold.listSessionsWithMetadata()).total).toBe(0)

			expect(recorded.errors).toEqual(['Failed to read session metadata'])
		})

		test('forgets cached metadata when the data root disappears', async () => {
			await createSession(store, testSessionId)
			expect((await store.listSessionsWithMetadata()).total).toBe(1)

			await rm(join(TEST_BASE_PATH, 'sessions'), { recursive: true, force: true })

			expect((await store.listSessionsWithMetadata()).total).toBe(0)
			expect(await store.getMetadata(testSessionId)).toBeNull()
		})

		test('hands out a copy, so a caller cannot mutate the cached record', async () => {
			await createSession(store, testSessionId)

			const handed = await store.getMetadata(testSessionId)
			expect(handed).not.toBeNull()
			if (handed) {
				handed.name = 'mutated'
				if (handed.metrics) handed.metrics.totalEvents = 999
			}

			const reread = await store.getMetadata(testSessionId)
			expect(reread?.name).toBeUndefined()
			expect(reread?.metrics?.totalEvents).toBe(1)
		})
	})

	describe('error handling', () => {
		test('throws EventStoreError on invalid JSON', async () => {
			const event = withSessionId(
				testSessionId,
				sessionEvents.create('session_created', {
					presetId: 'test-preset',
				}),
			)

			await store.append(testSessionId, event)

			// Manually append invalid JSON to the file
			const path = join(
				TEST_BASE_PATH,
				'sessions',
				testSessionId,
				'.events',
				'events.jsonl',
			)
			const { appendFile } = await import('node:fs/promises')
			await appendFile(path, 'invalid json\n', 'utf-8')

			// Should throw when trying to load
			await expect(store.load(testSessionId)).rejects.toThrow(EventStoreError)
		})
	})
})
