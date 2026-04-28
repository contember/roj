import { generateTestAgentId } from '~/core/agents/schema.js'
import { agentEvents } from '~/core/agents/state.js'
import type { agentEvents as AgentEventsType } from '~/core/agents/state.js'
import type { DomainEvent, FactoryEventType } from '~/core/events/types.js'
import type { SessionId } from '~/core/sessions/schema.js'
import { generateSessionId } from '~/core/sessions/schema.js'
import { isSessionCreatedEvent, sessionEvents } from '~/core/sessions/state.js'

type AgentEvent = FactoryEventType<typeof AgentEventsType>
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { withSessionId } from '~/core/events/test-helpers.js'
import { createNodeFileSystem } from '~/testing/node-platform.js'
import { EventStoreError } from './event-store.js'
import { FileEventStore } from './file.js'

const TEST_BASE_PATH = join(import.meta.dir, '.test-data')

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
