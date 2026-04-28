import { beforeEach, describe, expect, test } from 'bun:test'
import { generateTestAgentId } from '~/core/agents/schema.js'
import type { AgentSpawnedEvent } from '~/core/agents/state.js'
import { agentEvents } from '~/core/agents/state.js'
import { withSessionId } from '~/core/events/test-helpers.js'
import type { DomainEvent } from '~/core/events/types.js'
import { llmEvents } from '~/core/llm/state.js'
import { generateSessionId } from '~/core/sessions/schema.js'
import type { SessionId } from '~/core/sessions/schema.js'
import { sessionEvents } from '~/core/sessions/state.js'
import { MemoryEventStore } from './memory.js'

describe('MemoryEventStore', () => {
	let store: MemoryEventStore
	let testSessionId: SessionId

	beforeEach(() => {
		store = new MemoryEventStore()
		testSessionId = generateSessionId()
	})

	describe('append', () => {
		test('appends single event', async () => {
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
				events.push({ ...withSessionId(testSessionId, sessionEvents.create('session_created', { presetId: `preset-${i}` })), timestamp: Date.now() + i })
			}

			await store.appendBatch(testSessionId, events)
			const loaded = await store.load(testSessionId)

			expect(loaded).toHaveLength(5)
			for (let i = 0; i < 5; i++) {
				expect(loaded[i]).toMatchObject({ type: 'session_created', presetId: `preset-${i}` })
			}
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
			// Create 10 events
			const events: DomainEvent[] = []
			for (let i = 0; i < 10; i++) {
				events.push({ ...withSessionId(testSessionId, sessionEvents.create('session_created', { presetId: `preset-${i}` })), timestamp: Date.now() + i })
			}
			await store.appendBatch(testSessionId, events)

			// Load events after index 7 (should get events 8 and 9)
			const result = await store.loadRange(testSessionId, { since: 7 })
			expect(result.events).toHaveLength(2)
			expect(result.fromIndex).toBe(8)
			expect(result.toIndex).toBe(9)
			expect(result.events[0]).toMatchObject({ type: 'session_created', presetId: 'preset-8' })
			expect(result.events[1]).toMatchObject({ type: 'session_created', presetId: 'preset-9' })
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
			// Create 10 events
			const events: DomainEvent[] = []
			for (let i = 0; i < 10; i++) {
				events.push({ ...withSessionId(testSessionId, sessionEvents.create('session_created', { presetId: `preset-${i}` })), timestamp: Date.now() + i })
			}
			await store.appendBatch(testSessionId, events)

			// Load max 3 events after index 5
			const result = await store.loadRange(testSessionId, { since: 5, limit: 3 })
			expect(result.events).toHaveLength(3)
			expect(result.fromIndex).toBe(6)
			expect(result.toIndex).toBe(8)
			expect(result.events[0]).toMatchObject({ type: 'session_created', presetId: 'preset-6' })
			expect(result.events[1]).toMatchObject({ type: 'session_created', presetId: 'preset-7' })
			expect(result.events[2]).toMatchObject({ type: 'session_created', presetId: 'preset-8' })
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

	describe('test helpers', () => {
		test('clear removes all events', async () => {
			const session1 = generateSessionId()
			const session2 = generateSessionId()

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

			store.clear()

			const sessions = await store.listSessions()
			expect(sessions).toEqual([])
		})

		test('getAll returns a copy of all events', async () => {
			const session1 = generateSessionId()

			await store.append(
				session1,
				withSessionId(
					session1,
					sessionEvents.create('session_created', {
						presetId: 'test',
					}),
				),
			)

			const all = store.getAll()
			expect(all.size).toBe(1)
			expect(all.get(session1)).toHaveLength(1)

			// Verify it's a copy
			all.clear()
			const sessions = await store.listSessions()
			expect(sessions).toHaveLength(1)
		})

		test('getEventCount returns correct count', async () => {
			await store.append(
				testSessionId,
				withSessionId(
					testSessionId,
					sessionEvents.create('session_created', {
						presetId: 'test',
					}),
				),
			)

			await store.append(
				testSessionId,
				withSessionId(
					testSessionId,
					agentEvents.create('agent_spawned', {
						agentId: generateTestAgentId(),
						definitionName: 'test-agent',
						parentId: null,
					}),
				),
			)

			expect(store.getEventCount(testSessionId)).toBe(2)
			expect(store.getEventCount(generateSessionId())).toBe(0)
		})

		test('getLastEvent returns the last event', async () => {
			const agentId = generateTestAgentId()

			await store.append(
				testSessionId,
				withSessionId(
					testSessionId,
					sessionEvents.create('session_created', {
						presetId: 'test',
					}),
				),
			)

			await store.append(
				testSessionId,
				withSessionId(
					testSessionId,
					agentEvents.create('agent_spawned', {
						agentId,
						definitionName: 'test-agent',
						parentId: null,
					}),
				),
			)

			const lastEvent = store.getLastEvent(testSessionId)
			expect(lastEvent?.type).toBe('agent_spawned')

			// Non-existent session returns undefined
			expect(store.getLastEvent(generateSessionId())).toBeUndefined()
		})

		test('getEventsByType filters events by type', async () => {
			const agentId = generateTestAgentId()

			await store.append(
				testSessionId,
				withSessionId(
					testSessionId,
					sessionEvents.create('session_created', {
						presetId: 'test',
					}),
				),
			)

			await store.append(
				testSessionId,
				withSessionId(
					testSessionId,
					agentEvents.create('agent_spawned', {
						agentId,
						definitionName: 'agent-1',
						parentId: null,
					}),
				),
			)

			await store.append(
				testSessionId,
				withSessionId(
					testSessionId,
					agentEvents.create('agent_spawned', {
						agentId: generateTestAgentId(),
						definitionName: 'agent-2',
						parentId: null,
					}),
				),
			)

			const sessionCreatedEvents = store.getEventsByType(
				testSessionId,
				'session_created',
			)
			expect(sessionCreatedEvents).toHaveLength(1)
			expect(sessionCreatedEvents[0]?.type).toBe('session_created')

			const agentSpawnedEvents = store.getEventsByType(
				testSessionId,
				'agent_spawned',
			)
			expect(agentSpawnedEvents).toHaveLength(2)
			expect((agentSpawnedEvents[0] as AgentSpawnedEvent).definitionName).toBe('agent-1')
			expect((agentSpawnedEvents[1] as AgentSpawnedEvent).definitionName).toBe('agent-2')

			// Non-existent type returns empty array
			const closedEvents = store.getEventsByType(testSessionId, 'session_closed')
			expect(closedEvents).toEqual([])
		})
	})

	describe('metadata', () => {
		test('getMetadata returns null for non-existent session', async () => {
			const nonExistentId = generateSessionId()
			const metadata = await store.getMetadata(nonExistentId)
			expect(metadata).toBeNull()
		})

		test('auto-creates metadata on session_created event', async () => {
			const event = { ...withSessionId(testSessionId, sessionEvents.create('session_created', { presetId: 'test-preset' })), timestamp: 1000 }

			await store.append(testSessionId, event)

			const metadata = await store.getMetadata(testSessionId)
			expect(metadata).not.toBeNull()
			expect(metadata?.sessionId).toBe(testSessionId)
			expect(metadata?.presetId).toBe('test-preset')
			expect(metadata?.createdAt).toBe(1000)
			expect(metadata?.status).toBe('active')
			expect(metadata?.metrics?.totalEvents).toBe(1)
			expect(metadata?.metrics?.totalAgents).toBe(0)
			expect(metadata?.metrics?.totalTokens).toBe(0)
			expect(metadata?.metrics?.totalLLMCalls).toBe(0)
		})

		test('updates metrics on agent_spawned event', async () => {
			await store.append(testSessionId, {
				...withSessionId(testSessionId, sessionEvents.create('session_created', { presetId: 'test-preset' })),
				timestamp: 1000,
			})

			await store.append(testSessionId, {
				...withSessionId(
					testSessionId,
					agentEvents.create('agent_spawned', {
						agentId: generateTestAgentId(),
						definitionName: 'test-agent',
						parentId: null,
					}),
				),
				timestamp: 2000,
			})

			const metadata = await store.getMetadata(testSessionId)
			expect(metadata?.metrics?.totalEvents).toBe(2)
			expect(metadata?.metrics?.totalAgents).toBe(1)
			expect(metadata?.lastActivityAt).toBe(2000)
		})

		test('updates metrics on inference_completed event', async () => {
			const agentId = generateTestAgentId()

			await store.append(testSessionId, {
				...withSessionId(testSessionId, sessionEvents.create('session_created', { presetId: 'test-preset' })),
				timestamp: 1000,
			})

			const inferenceEvent = {
				...withSessionId(
					testSessionId,
					llmEvents.create('inference_completed', {
						agentId,
						consumedMessageIds: [],
						response: {
							content: 'test',
							toolCalls: [],
						},
						metrics: {
							promptTokens: 100,
							completionTokens: 50,
							totalTokens: 150,
							latencyMs: 500,
							model: 'test-model',
						},
					}),
				),
				timestamp: 2000,
			}

			await store.append(testSessionId, inferenceEvent)

			const metadata = await store.getMetadata(testSessionId)
			expect(metadata?.metrics?.totalEvents).toBe(2)
			expect(metadata?.metrics?.totalTokens).toBe(150)
			expect(metadata?.metrics?.totalLLMCalls).toBe(1)
		})

		test('updates status on session_closed event', async () => {
			await store.append(testSessionId, {
				...withSessionId(testSessionId, sessionEvents.create('session_created', { presetId: 'test-preset' })),
				timestamp: 1000,
			})

			const beforeClose = Date.now()
			await store.append(testSessionId, withSessionId(testSessionId, sessionEvents.create('session_closed', {})))

			const metadata = await store.getMetadata(testSessionId)
			expect(metadata?.status).toBe('closed')
			expect(metadata?.lastActivityAt).toBeGreaterThanOrEqual(beforeClose)
		})

		test('updateMetadata updates fields', async () => {
			await store.append(testSessionId, {
				...withSessionId(testSessionId, sessionEvents.create('session_created', { presetId: 'test-preset' })),
				timestamp: 1000,
			})

			await store.updateMetadata(testSessionId, {
				name: 'My Session',
				tags: ['tag1', 'tag2'],
			})

			const metadata = await store.getMetadata(testSessionId)
			expect(metadata?.name).toBe('My Session')
			expect(metadata?.tags).toEqual(['tag1', 'tag2'])
		})
	})

	describe('listSessionsWithMetadata', () => {
		test('returns empty list when no sessions exist', async () => {
			const result = await store.listSessionsWithMetadata()
			expect(result.sessions).toEqual([])
			expect(result.total).toBe(0)
		})

		test('returns all sessions with metadata', async () => {
			const session1 = generateSessionId()
			const session2 = generateSessionId()

			await store.append(session1, { ...withSessionId(session1, sessionEvents.create('session_created', { presetId: 'preset-1' })), timestamp: 1000 })

			await store.append(session2, { ...withSessionId(session2, sessionEvents.create('session_created', { presetId: 'preset-2' })), timestamp: 2000 })

			const result = await store.listSessionsWithMetadata()
			expect(result.sessions).toHaveLength(2)
			expect(result.total).toBe(2)
		})

		test('filters by status', async () => {
			const session1 = generateSessionId()
			const session2 = generateSessionId()

			await store.append(session1, { ...withSessionId(session1, sessionEvents.create('session_created', { presetId: 'preset-1' })), timestamp: 1000 })

			await store.append(session2, { ...withSessionId(session2, sessionEvents.create('session_created', { presetId: 'preset-2' })), timestamp: 2000 })

			await store.append(session2, withSessionId(session2, sessionEvents.create('session_closed', {})))

			const activeResult = await store.listSessionsWithMetadata({
				status: 'active',
			})
			expect(activeResult.sessions).toHaveLength(1)
			expect(activeResult.sessions[0]?.sessionId).toBe(session1)

			const closedResult = await store.listSessionsWithMetadata({
				status: 'closed',
			})
			expect(closedResult.sessions).toHaveLength(1)
			expect(closedResult.sessions[0]?.sessionId).toBe(session2)
		})

		test('filters by tags', async () => {
			const session1 = generateSessionId()
			const session2 = generateSessionId()

			await store.append(session1, { ...withSessionId(session1, sessionEvents.create('session_created', { presetId: 'preset-1' })), timestamp: 1000 })

			await store.append(session2, { ...withSessionId(session2, sessionEvents.create('session_created', { presetId: 'preset-2' })), timestamp: 2000 })

			await store.updateMetadata(session1, { tags: ['important', 'project-a'] })
			await store.updateMetadata(session2, { tags: ['project-b'] })

			const result = await store.listSessionsWithMetadata({
				tags: ['important'],
			})
			expect(result.sessions).toHaveLength(1)
			expect(result.sessions[0]?.sessionId).toBe(session1)
		})

		test('sorts by createdAt descending by default', async () => {
			const session1 = generateSessionId()
			const session2 = generateSessionId()
			const session3 = generateSessionId()

			await store.append(session1, { ...withSessionId(session1, sessionEvents.create('session_created', { presetId: 'preset-1' })), timestamp: 1000 })

			await store.append(session2, { ...withSessionId(session2, sessionEvents.create('session_created', { presetId: 'preset-2' })), timestamp: 3000 })

			await store.append(session3, { ...withSessionId(session3, sessionEvents.create('session_created', { presetId: 'preset-3' })), timestamp: 2000 })

			const result = await store.listSessionsWithMetadata()
			expect(result.sessions[0]?.sessionId).toBe(session2)
			expect(result.sessions[1]?.sessionId).toBe(session3)
			expect(result.sessions[2]?.sessionId).toBe(session1)
		})

		test('sorts by lastActivityAt ascending', async () => {
			const session1 = generateSessionId()
			const session2 = generateSessionId()

			await store.append(session1, { ...withSessionId(session1, sessionEvents.create('session_created', { presetId: 'preset-1' })), timestamp: 1000 })

			await store.append(session2, { ...withSessionId(session2, sessionEvents.create('session_created', { presetId: 'preset-2' })), timestamp: 2000 })

			// Add activity to session1 later
			await store.append(session1, {
				...withSessionId(
					session1,
					agentEvents.create('agent_spawned', {
						agentId: generateTestAgentId(),
						definitionName: 'test-agent',
						parentId: null,
					}),
				),
				timestamp: 5000,
			})

			const result = await store.listSessionsWithMetadata({
				orderBy: 'lastActivityAt',
				order: 'asc',
			})
			expect(result.sessions[0]?.sessionId).toBe(session2)
			expect(result.sessions[1]?.sessionId).toBe(session1)
		})

		test('paginates results', async () => {
			const sessions: SessionId[] = []
			for (let i = 0; i < 5; i++) {
				const sessionId = generateSessionId()
				sessions.push(sessionId)
				await store.append(sessionId, {
					...withSessionId(sessionId, sessionEvents.create('session_created', { presetId: `preset-${i}` })),
					timestamp: i * 1000,
				})
			}

			const page1 = await store.listSessionsWithMetadata({
				limit: 2,
				offset: 0,
				orderBy: 'createdAt',
				order: 'asc',
			})
			expect(page1.sessions).toHaveLength(2)
			expect(page1.total).toBe(5)
			expect(page1.sessions[0]?.presetId).toBe('preset-0')
			expect(page1.sessions[1]?.presetId).toBe('preset-1')

			const page2 = await store.listSessionsWithMetadata({
				limit: 2,
				offset: 2,
				orderBy: 'createdAt',
				order: 'asc',
			})
			expect(page2.sessions).toHaveLength(2)
			expect(page2.sessions[0]?.presetId).toBe('preset-2')
			expect(page2.sessions[1]?.presetId).toBe('preset-3')
		})

		test('clear removes metadata too', async () => {
			const session1 = generateSessionId()

			await store.append(session1, { ...withSessionId(session1, sessionEvents.create('session_created', { presetId: 'test' })), timestamp: 1000 })

			store.clear()

			const metadata = await store.getMetadata(session1)
			expect(metadata).toBeNull()

			const result = await store.listSessionsWithMetadata()
			expect(result.sessions).toEqual([])
		})
	})
})
