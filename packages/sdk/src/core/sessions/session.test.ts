import { describe, expect, it } from 'bun:test'
import { COMMUNICATOR_ROLE, ORCHESTRATOR_ROLE } from '~/core/agents/agent-roles.js'
import { generateTestAgentId } from '~/core/agents/schema.js'
import { agentEvents } from '~/core/agents/state.js'
import { withSessionId } from '~/core/events/test-helpers.js'
import type { DomainEvent } from '~/core/events/types.js'
import { llmEvents } from '~/core/llm/state.js'
import { generateSessionId } from '~/core/sessions/schema.js'
import { sessionEvents } from '~/core/sessions/state.js'
import { generateToolCallId } from '~/core/tools/schema.js'
import { toolEvents } from '~/core/tools/state.js'
import { mailboxPlugin } from '~/plugins/mailbox/plugin.js'
import { getAgentMailbox, selectMailboxState } from '~/plugins/mailbox/query.js'
import { generateTestMessageId } from '~/plugins/mailbox/schema.js'
import { mailboxEvents } from '~/plugins/mailbox/state.js'
import { createApplyEvent } from './apply-event.js'
import { createSessionState, getAgentState, getCommunicatorId, getEntryAgentId, getOrchestratorId, reconstructSessionState } from './state.js'

const applyEvent = createApplyEvent([mailboxPlugin.create({})])

const SESSION_ID = generateSessionId()
const TIMESTAMP = Date.now()

describe('createSessionState', () => {
	it('creates an empty session with correct properties', () => {
		const session = createSessionState(SESSION_ID, 'test-preset', TIMESTAMP)

		expect(session.id).toBe(SESSION_ID)
		expect(session.presetId).toBe('test-preset')
		expect(session.status).toBe('active')
		expect(session.agents.size).toBe(0)
		expect(session.createdAt).toBe(TIMESTAMP)
		expect(session.closedAt).toBeUndefined()
	})
})

describe('applyEvent', () => {
	const baseSession = createSessionState(SESSION_ID, 'test-preset', TIMESTAMP)

	describe('session_closed', () => {
		it('closes the session', () => {
			const event = withSessionId(SESSION_ID, sessionEvents.create('session_closed', {}))

			const result = applyEvent(baseSession, event)

			expect(result.status).toBe('closed')
			expect(result.closedAt).toBe(event.timestamp)
		})
	})

	describe('agent_spawned', () => {
		it('adds a new agent to the session', () => {
			const agentId = generateTestAgentId()
			const event = withSessionId(
				SESSION_ID,
				agentEvents.create('agent_spawned', {
					agentId,
					definitionName: ORCHESTRATOR_ROLE,
					parentId: null,
				}),
			)

			const result = applyEvent(baseSession, event)

			expect(result.agents.size).toBe(1)
			const agent = result.agents.get(agentId)
			expect(agent).toBeDefined()
			expect(agent!.id).toBe(agentId)
			expect(agent!.definitionName).toBe(ORCHESTRATOR_ROLE)
			expect(agent!.parentId).toBeNull()
			expect(agent!.status).toBe('pending')
			expect(getAgentMailbox(selectMailboxState(result), agentId)).toHaveLength(0)
		})

		it('adds child agent with parent reference', () => {
			const parentId = generateTestAgentId()
			const childId = generateTestAgentId()

			let session = applyEvent(
				baseSession,
				withSessionId(
					SESSION_ID,
					agentEvents.create('agent_spawned', {
						agentId: parentId,
						definitionName: ORCHESTRATOR_ROLE,
						parentId: null,
					}),
				),
			)

			session = applyEvent(
				session,
				withSessionId(
					SESSION_ID,
					agentEvents.create('agent_spawned', {
						agentId: childId,
						definitionName: 'worker',
						parentId: parentId,
					}),
				),
			)

			const child = session.agents.get(childId)
			expect(child!.parentId).toBe(parentId)
		})
	})

	describe('agent_state_changed', () => {
		it('updates agent status', () => {
			const agentId = generateTestAgentId()
			let session = applyEvent(
				baseSession,
				withSessionId(
					SESSION_ID,
					agentEvents.create('agent_spawned', {
						agentId,
						definitionName: 'test',
						parentId: null,
					}),
				),
			)

			const event = withSessionId(
				SESSION_ID,
				agentEvents.create('agent_state_changed', {
					agentId,
					fromState: 'pending',
					toState: 'inferring',
				}),
			)

			session = applyEvent(session, event)

			expect(session.agents.get(agentId)!.status).toBe('inferring')
		})

		it('throws for unknown agent', () => {
			const unknownAgentId = generateTestAgentId()
			const event = withSessionId(
				SESSION_ID,
				agentEvents.create('agent_state_changed', {
					agentId: unknownAgentId,
					fromState: 'pending',
					toState: 'inferring',
				}),
			)

			expect(() => applyEvent(baseSession, event)).toThrow(
				`Agent not found: ${unknownAgentId}`,
			)
		})
	})

	describe('mailbox_message', () => {
		it('adds message to agent mailbox', () => {
			const agentId = generateTestAgentId()
			let session = applyEvent(
				baseSession,
				withSessionId(
					SESSION_ID,
					agentEvents.create('agent_spawned', {
						agentId,
						definitionName: 'test',
						parentId: null,
					}),
				),
			)

			const messageId = generateTestMessageId()
			const event = withSessionId(
				SESSION_ID,
				mailboxEvents.create('mailbox_message', {
					toAgentId: agentId,
					message: {
						id: messageId,
						from: 'user',
						content: 'Hello',
						timestamp: TIMESTAMP,
						consumed: false,
					},
				}),
			)

			session = applyEvent(session, event)

			const mailbox = getAgentMailbox(selectMailboxState(session), agentId)
			expect(mailbox).toHaveLength(1)
			expect(mailbox[0].id).toBe(messageId)
			expect(mailbox[0].content).toBe('Hello')
		})
	})

	describe('mailbox_consumed', () => {
		it('marks messages as consumed', () => {
			const agentId = generateTestAgentId()
			const messageId = generateTestMessageId()

			let session = applyEvent(
				baseSession,
				withSessionId(
					SESSION_ID,
					agentEvents.create('agent_spawned', {
						agentId,
						definitionName: 'test',
						parentId: null,
					}),
				),
			)

			session = applyEvent(
				session,
				withSessionId(
					SESSION_ID,
					mailboxEvents.create('mailbox_message', {
						toAgentId: agentId,
						message: {
							id: messageId,
							from: 'user',
							content: 'Hello',
							timestamp: TIMESTAMP,
							consumed: false,
						},
					}),
				),
			)

			const event = withSessionId(
				SESSION_ID,
				mailboxEvents.create('mailbox_consumed', {
					agentId,
					messageIds: [messageId],
				}),
			)

			session = applyEvent(session, event)

			expect(getAgentMailbox(selectMailboxState(session), agentId)[0].consumed).toBe(true)
		})
	})

	describe('inference_started', () => {
		it('sets agent status to inferring', () => {
			const agentId = generateTestAgentId()
			let session = applyEvent(
				baseSession,
				withSessionId(
					SESSION_ID,
					agentEvents.create('agent_spawned', {
						agentId,
						definitionName: 'test',
						parentId: null,
					}),
				),
			)

			const event = withSessionId(
				SESSION_ID,
				llmEvents.create('inference_started', {
					agentId,
					messages: [],
					consumedMessageIds: [],
				}),
			)

			session = applyEvent(session, event)

			expect(session.agents.get(agentId)!.status).toBe('inferring')
		})

		it('appends to pendingMessages (defense-in-depth against uncommitted messages)', () => {
			// If for any reason pendingMessages are not empty when inference_started fires,
			// they must not be overwritten — append instead.
			const agentId = generateTestAgentId()

			let session = applyEvent(
				baseSession,
				withSessionId(
					SESSION_ID,
					agentEvents.create('agent_spawned', {
						agentId,
						definitionName: 'test',
						parentId: null,
					}),
				),
			)

			const msg1 = { role: 'user' as const, content: 'First message' }
			const msg2 = { role: 'user' as const, content: 'Second message' }

			// First inference_started sets pendingMessages
			session = applyEvent(
				session,
				withSessionId(
					SESSION_ID,
					llmEvents.create('inference_started', {
						agentId,
						messages: [msg1],
						consumedMessageIds: [],
					}),
				),
			)

			expect(session.agents.get(agentId)!.pendingMessages).toHaveLength(1)

			// Second inference_started without inference_completed in between —
			// must append, not overwrite
			session = applyEvent(
				session,
				withSessionId(
					SESSION_ID,
					llmEvents.create('inference_started', {
						agentId,
						messages: [msg2],
						consumedMessageIds: [],
					}),
				),
			)

			const agent = session.agents.get(agentId)!
			expect(agent.pendingMessages).toHaveLength(2)
			expect(agent.pendingMessages[0].content).toBe(msg1.content)
			expect(agent.pendingMessages[1].content).toBe(msg2.content)
		})

		it('afterInference pause: inference_completed commits turn, then agent_paused preserves pause', () => {
			// Real scenario: planner receives subagent response, LLM says "WAITING",
			// limits-guard pauses. The correct event sequence is:
			//   inference_started → inference_completed → agent_paused
			// This ensures conversationHistory includes the turn and pendingMessages are cleared.
			const agentId = generateTestAgentId()

			let session = applyEvent(
				baseSession,
				withSessionId(
					SESSION_ID,
					agentEvents.create('agent_spawned', {
						agentId,
						definitionName: 'test',
						parentId: null,
					}),
				),
			)

			const userMsg = { role: 'user' as const, content: 'Response from collection-analyzer_1 (locations)' }

			// 1. inference_started — message goes to pendingMessages
			session = applyEvent(
				session,
				withSessionId(
					SESSION_ID,
					llmEvents.create('inference_started', {
						agentId,
						messages: [userMsg],
						consumedMessageIds: [],
					}),
				),
			)

			expect(session.agents.get(agentId)!.pendingMessages).toHaveLength(1)
			expect(session.agents.get(agentId)!.status).toBe('inferring')

			// 2. inference_completed — pendingMessages + response committed to conversationHistory
			session = applyEvent(
				session,
				withSessionId(
					SESSION_ID,
					llmEvents.create('inference_completed', {
						agentId,
						consumedMessageIds: [],
						response: { content: 'WAITING', toolCalls: [] },
						metrics: { promptTokens: 200, completionTokens: 1, totalTokens: 201, latencyMs: 500, model: 'test' },
					}),
				),
			)

			expect(session.agents.get(agentId)!.pendingMessages).toHaveLength(0)
			expect(session.agents.get(agentId)!.conversationHistory).toHaveLength(2) // user + assistant
			expect(session.agents.get(agentId)!.status).toBe('pending')

			// 3. agent_paused — status set to paused, conversationHistory preserved
			session = applyEvent(
				session,
				withSessionId(
					SESSION_ID,
					agentEvents.create('agent_paused', {
						agentId,
						reason: 'handler',
						message: 'No progress for 5 turns',
					}),
				),
			)

			const agent = session.agents.get(agentId)!
			expect(agent.status).toBe('paused')
			expect(agent.pendingMessages).toHaveLength(0)
			expect(agent.conversationHistory).toHaveLength(2)
			expect(agent.conversationHistory[0].content).toBe(userMsg.content)
			expect(agent.conversationHistory[1].content).toBe('WAITING')

			// 4. Resume + next message — starts fresh with empty pendingMessages
			session = applyEvent(
				session,
				withSessionId(
					SESSION_ID,
					agentEvents.create('agent_resumed', { agentId }),
				),
			)

			const nextMsg = { role: 'user' as const, content: 'Response from collection-analyzer_2 (team)' }

			session = applyEvent(
				session,
				withSessionId(
					SESSION_ID,
					llmEvents.create('inference_started', {
						agentId,
						messages: [nextMsg],
						consumedMessageIds: [],
					}),
				),
			)

			// Only the new message in pendingMessages (previous turn was committed)
			expect(session.agents.get(agentId)!.pendingMessages).toHaveLength(1)
			expect(session.agents.get(agentId)!.pendingMessages[0].content).toBe(nextMsg.content)
			// Previous turn preserved in conversationHistory
			expect(session.agents.get(agentId)!.conversationHistory).toHaveLength(2)
		})
	})

	describe('inference_completed', () => {
		it('updates conversation history and status when no tool calls', () => {
			const agentId = generateTestAgentId()
			let session = applyEvent(
				baseSession,
				withSessionId(
					SESSION_ID,
					agentEvents.create('agent_spawned', {
						agentId,
						definitionName: 'test',
						parentId: null,
					}),
				),
			)

			const event = withSessionId(
				SESSION_ID,
				llmEvents.create('inference_completed', {
					agentId,
					consumedMessageIds: [],
					response: {
						content: 'Hello there!',
						toolCalls: [],
					},
					metrics: {
						promptTokens: 100,
						completionTokens: 10,
						totalTokens: 110,
						latencyMs: 500,
						model: 'test-model',
					},
				}),
			)

			session = applyEvent(session, event)

			const agent = session.agents.get(agentId)!
			expect(agent.status).toBe('pending')
			expect(agent.conversationHistory).toHaveLength(1)
			expect(agent.conversationHistory[0].role).toBe('assistant')
			expect(agent.conversationHistory[0].content).toBe('Hello there!')
			expect(agent.pendingToolCalls).toHaveLength(0)
		})

		it('marks consumed messages via mailbox_consumed event', () => {
			const agentId = generateTestAgentId()
			const messageId = generateTestMessageId()

			let session = applyEvent(
				baseSession,
				withSessionId(
					SESSION_ID,
					agentEvents.create('agent_spawned', {
						agentId,
						definitionName: 'test',
						parentId: null,
					}),
				),
			)

			session = applyEvent(
				session,
				withSessionId(
					SESSION_ID,
					mailboxEvents.create('mailbox_message', {
						toAgentId: agentId,
						message: {
							id: messageId,
							from: 'user',
							content: 'Hello',
							timestamp: TIMESTAMP,
							consumed: false,
						},
					}),
				),
			)

			// Before consumption, message should be unconsumed
			expect(getAgentMailbox(selectMailboxState(session), agentId)[0].consumed).toBe(false)

			// Consume via mailbox_consumed (the dequeue mechanism)
			session = applyEvent(
				session,
				withSessionId(
					SESSION_ID,
					mailboxEvents.create('mailbox_consumed', {
						agentId,
						messageIds: [messageId],
					}),
				),
			)

			// After mailbox_consumed, message should be consumed
			expect(getAgentMailbox(selectMailboxState(session), agentId)[0].consumed).toBe(true)

			// Inference still works after consumption
			session = applyEvent(
				session,
				withSessionId(
					SESSION_ID,
					llmEvents.create('inference_completed', {
						agentId,
						consumedMessageIds: [],
						response: {
							content: 'Hi!',
							toolCalls: [],
						},
						metrics: {
							promptTokens: 100,
							completionTokens: 10,
							totalTokens: 110,
							latencyMs: 500,
							model: 'test-model',
						},
					}),
				),
			)

			expect(session.agents.get(agentId)!.conversationHistory).toHaveLength(1)
		})

		it('sets tool_exec status when there are tool calls', () => {
			const agentId = generateTestAgentId()
			const toolCallId = generateToolCallId()
			let session = applyEvent(
				baseSession,
				withSessionId(
					SESSION_ID,
					agentEvents.create('agent_spawned', {
						agentId,
						definitionName: 'test',
						parentId: null,
					}),
				),
			)

			const event = withSessionId(
				SESSION_ID,
				llmEvents.create('inference_completed', {
					agentId,
					consumedMessageIds: [],
					response: {
						content: null,
						toolCalls: [
							{
								id: toolCallId,
								name: 'send_message',
								input: { to: 'other', content: 'hi' },
							},
						],
					},
					metrics: {
						promptTokens: 100,
						completionTokens: 20,
						totalTokens: 120,
						latencyMs: 600,
						model: 'test-model',
					},
				}),
			)

			session = applyEvent(session, event)

			const agent = session.agents.get(agentId)!
			expect(agent.status).toBe('tool_exec')
			expect(agent.pendingToolCalls).toHaveLength(1)
			expect(agent.pendingToolCalls[0].name).toBe('send_message')
		})
	})

	describe('inference_failed', () => {
		it('sets agent status to errored', () => {
			const agentId = generateTestAgentId()
			let session = applyEvent(
				baseSession,
				withSessionId(
					SESSION_ID,
					agentEvents.create('agent_spawned', {
						agentId,
						definitionName: 'test',
						parentId: null,
					}),
				),
			)

			const event = withSessionId(
				SESSION_ID,
				llmEvents.create('inference_failed', {
					agentId,
					error: 'API error',
				}),
			)

			session = applyEvent(session, event)

			expect(session.agents.get(agentId)!.status).toBe('errored')
		})

		it('clears pendingMessages but preserves pendingToolResults and mailbox for retry', () => {
			const agentId = generateTestAgentId()
			const messageId = generateTestMessageId()
			const toolCallId = generateToolCallId()

			// 1. Spawn agent
			let session = applyEvent(
				baseSession,
				withSessionId(
					SESSION_ID,
					agentEvents.create('agent_spawned', {
						agentId,
						definitionName: 'test',
						parentId: null,
					}),
				),
			)

			// 2. Add mailbox message
			session = applyEvent(
				session,
				withSessionId(
					SESSION_ID,
					mailboxEvents.create('mailbox_message', {
						toAgentId: agentId,
						message: {
							id: messageId,
							from: 'user',
							content: 'Hello',
							timestamp: TIMESTAMP,
							consumed: false,
						},
					}),
				),
			)

			// 3. First inference with tool call
			session = applyEvent(
				session,
				withSessionId(
					SESSION_ID,
					llmEvents.create('inference_completed', {
						agentId,
						consumedMessageIds: [],
						response: {
							content: null,
							toolCalls: [{ id: toolCallId, name: 'test_tool', input: {} }],
						},
						metrics: { promptTokens: 100, completionTokens: 10, totalTokens: 110, latencyMs: 500, model: 'test' },
					}),
				),
			)

			// 4. Tool completes - creates pendingToolResult
			session = applyEvent(
				session,
				withSessionId(
					SESSION_ID,
					toolEvents.create('tool_completed', {
						agentId,
						toolCallId,
						result: 'tool output',
					}),
				),
			)

			// 5. Start inference with pending messages
			session = applyEvent(
				session,
				withSessionId(
					SESSION_ID,
					llmEvents.create('inference_started', {
						agentId,
						messages: [
							{ role: 'tool' as const, toolCallId, toolName: 'test_tool', content: 'tool output', isError: false, timestamp: TIMESTAMP },
							{ role: 'user' as const, content: 'formatted mailbox', sourceMessageIds: [messageId] },
						],
						consumedMessageIds: [messageId],
					}),
				),
			)

			// Verify pendingMessages are set
			expect(session.agents.get(agentId)!.pendingMessages).toHaveLength(2)
			expect(session.agents.get(agentId)!.status).toBe('inferring')

			// 6. Inference fails
			session = applyEvent(
				session,
				withSessionId(
					SESSION_ID,
					llmEvents.create('inference_failed', {
						agentId,
						error: 'API timeout',
					}),
				),
			)

			const agent = session.agents.get(agentId)!

			// pendingMessages cleared
			expect(agent.pendingMessages).toHaveLength(0)
			// pendingToolResults preserved for rebuild
			expect(agent.pendingToolResults).toHaveLength(1)
			expect(agent.pendingToolResults[0].toolCallId).toBe(toolCallId)
			// mailbox NOT consumed (can rebuild user message)
			expect(getAgentMailbox(selectMailboxState(session), agentId)[0].consumed).toBe(false)
			// status is errored
			expect(agent.status).toBe('errored')
		})
	})

	describe('session_restarted', () => {
		it('clears pendingMessages for inferring agents, preserves pendingToolResults and mailbox', () => {
			const agentId = generateTestAgentId()
			const messageId = generateTestMessageId()
			const toolCallId = generateToolCallId()

			// 1. Spawn agent
			let session = applyEvent(
				baseSession,
				withSessionId(
					SESSION_ID,
					agentEvents.create('agent_spawned', {
						agentId,
						definitionName: 'test',
						parentId: null,
					}),
				),
			)

			// 2. Add mailbox message
			session = applyEvent(
				session,
				withSessionId(
					SESSION_ID,
					mailboxEvents.create('mailbox_message', {
						toAgentId: agentId,
						message: {
							id: messageId,
							from: 'user',
							content: 'Hello',
							timestamp: TIMESTAMP,
							consumed: false,
						},
					}),
				),
			)

			// 3. First inference with tool call
			session = applyEvent(
				session,
				withSessionId(
					SESSION_ID,
					llmEvents.create('inference_completed', {
						agentId,
						consumedMessageIds: [],
						response: {
							content: null,
							toolCalls: [{ id: toolCallId, name: 'test_tool', input: {} }],
						},
						metrics: { promptTokens: 100, completionTokens: 10, totalTokens: 110, latencyMs: 500, model: 'test' },
					}),
				),
			)

			// 4. Tool completes
			session = applyEvent(
				session,
				withSessionId(
					SESSION_ID,
					toolEvents.create('tool_completed', {
						agentId,
						toolCallId,
						result: 'tool output',
					}),
				),
			)

			// 5. Start inference
			session = applyEvent(
				session,
				withSessionId(
					SESSION_ID,
					llmEvents.create('inference_started', {
						agentId,
						messages: [
							{ role: 'tool' as const, toolCallId, toolName: 'test_tool', content: 'tool output', isError: false, timestamp: TIMESTAMP },
							{ role: 'user' as const, content: 'formatted mailbox', sourceMessageIds: [messageId] },
						],
						consumedMessageIds: [messageId],
					}),
				),
			)

			// Verify state before restart
			expect(session.agents.get(agentId)!.pendingMessages).toHaveLength(2)
			expect(session.agents.get(agentId)!.status).toBe('inferring')

			// 6. Server restarts
			session = applyEvent(session, {
				...withSessionId(
					SESSION_ID,
					sessionEvents.create('session_restarted', {
						resetAgentIds: [agentId],
						clearedToolAgentIds: [],
					}),
				),
				timestamp: TIMESTAMP + 1000,
			})

			const agent = session.agents.get(agentId)!

			// pendingMessages cleared
			expect(agent.pendingMessages).toHaveLength(0)
			// pendingToolResults preserved - can rebuild tool messages
			expect(agent.pendingToolResults).toHaveLength(1)
			expect(agent.pendingToolResults[0].toolCallId).toBe(toolCallId)
			// mailbox NOT consumed - can rebuild user message
			expect(getAgentMailbox(selectMailboxState(session), agentId)[0].consumed).toBe(false)
			// status reset to pending
			expect(agent.status).toBe('pending')
		})

		it('allows successful retry after restart - full cycle', () => {
			const agentId = generateTestAgentId()
			const messageId = generateTestMessageId()
			const toolCallId = generateToolCallId()

			// 1. Setup: spawn, message, tool call, tool complete
			let session = applyEvent(
				baseSession,
				withSessionId(
					SESSION_ID,
					agentEvents.create('agent_spawned', {
						agentId,
						definitionName: 'test',
						parentId: null,
					}),
				),
			)

			session = applyEvent(
				session,
				withSessionId(
					SESSION_ID,
					mailboxEvents.create('mailbox_message', {
						toAgentId: agentId,
						message: { id: messageId, from: 'user', content: 'Hello', timestamp: TIMESTAMP, consumed: false },
					}),
				),
			)

			session = applyEvent(
				session,
				withSessionId(
					SESSION_ID,
					llmEvents.create('inference_completed', {
						agentId,
						consumedMessageIds: [],
						response: { content: null, toolCalls: [{ id: toolCallId, name: 'test_tool', input: {} }] },
						metrics: { promptTokens: 100, completionTokens: 10, totalTokens: 110, latencyMs: 500, model: 'test' },
					}),
				),
			)

			session = applyEvent(
				session,
				withSessionId(
					SESSION_ID,
					toolEvents.create('tool_completed', {
						agentId,
						toolCallId,
						result: 'tool output',
					}),
				),
			)

			// 2. First inference attempt - interrupted by restart
			session = applyEvent(
				session,
				withSessionId(
					SESSION_ID,
					llmEvents.create('inference_started', {
						agentId,
						messages: [
							{ role: 'tool' as const, toolCallId, toolName: 'test_tool', content: 'tool output', isError: false, timestamp: TIMESTAMP },
							{ role: 'user' as const, content: 'formatted mailbox v1', sourceMessageIds: [messageId] },
						],
						consumedMessageIds: [messageId],
					}),
				),
			)

			session = applyEvent(session, {
				...withSessionId(
					SESSION_ID,
					sessionEvents.create('session_restarted', {
						resetAgentIds: [agentId],
						clearedToolAgentIds: [],
					}),
				),
				timestamp: TIMESTAMP + 1000,
			})

			// 3. Retry inference - rebuild messages from preserved state
			const agentAfterRestart = session.agents.get(agentId)!
			expect(agentAfterRestart.status).toBe('pending')
			expect(agentAfterRestart.pendingToolResults).toHaveLength(1)
			expect(getAgentMailbox(selectMailboxState(session), agentId)[0].consumed).toBe(false)

			// Runtime would rebuild: tool message from pendingToolResults + user message from unconsumed mailbox
			session = applyEvent(session, {
				...withSessionId(
					SESSION_ID,
					llmEvents.create('inference_started', {
						agentId,
						messages: [
							{ role: 'tool' as const, toolCallId, toolName: 'test_tool', content: 'tool output', isError: false, timestamp: TIMESTAMP },
							{ role: 'user' as const, content: 'formatted mailbox v2', sourceMessageIds: [messageId] },
						],
						consumedMessageIds: [messageId],
					}),
				),
				timestamp: TIMESTAMP + 2000,
			})

			// 4. Dequeue mechanism marks messages consumed
			session = applyEvent(
				session,
				withSessionId(
					SESSION_ID,
					mailboxEvents.create('mailbox_consumed', {
						agentId,
						messageIds: [messageId],
					}),
				),
			)

			// 5. This time inference completes successfully
			session = applyEvent(session, {
				...withSessionId(
					SESSION_ID,
					llmEvents.create('inference_completed', {
						agentId,
						consumedMessageIds: [],
						response: { content: 'Done!', toolCalls: [] },
						metrics: { promptTokens: 100, completionTokens: 10, totalTokens: 110, latencyMs: 500, model: 'test' },
					}),
				),
				timestamp: TIMESTAMP + 3000,
			})

			const finalAgent = session.agents.get(agentId)!

			// Everything committed
			expect(finalAgent.status).toBe('pending')
			expect(finalAgent.pendingMessages).toHaveLength(0)
			expect(finalAgent.pendingToolResults).toHaveLength(0)
			expect(getAgentMailbox(selectMailboxState(session), agentId)[0].consumed).toBe(true)

			// History contains: assistant (tool call) + tool + user + assistant (final)
			expect(finalAgent.conversationHistory).toHaveLength(4)
			expect(finalAgent.conversationHistory[0].role).toBe('assistant')
			expect(finalAgent.conversationHistory[1].role).toBe('tool')
			expect(finalAgent.conversationHistory[2].role).toBe('user')
			expect(finalAgent.conversationHistory[3].role).toBe('assistant')
			expect(finalAgent.conversationHistory[3].content).toBe('Done!')
		})
	})

	describe('tool_completed', () => {
		it('removes tool call from pending and updates status', () => {
			const agentId = generateTestAgentId()
			const toolCallId = generateToolCallId()

			let session = applyEvent(
				baseSession,
				withSessionId(
					SESSION_ID,
					agentEvents.create('agent_spawned', {
						agentId,
						definitionName: 'test',
						parentId: null,
					}),
				),
			)

			session = applyEvent(
				session,
				withSessionId(
					SESSION_ID,
					llmEvents.create('inference_completed', {
						agentId,
						consumedMessageIds: [],
						response: {
							content: null,
							toolCalls: [{ id: toolCallId, name: 'test', input: {} }],
						},
						metrics: {
							promptTokens: 100,
							completionTokens: 10,
							totalTokens: 110,
							latencyMs: 500,
							model: 'test-model',
						},
					}),
				),
			)

			const event = withSessionId(
				SESSION_ID,
				toolEvents.create('tool_completed', {
					agentId,
					toolCallId,
					result: 'success',
				}),
			)

			session = applyEvent(session, event)

			const agent = session.agents.get(agentId)!
			expect(agent.pendingToolCalls).toHaveLength(0)
			expect(agent.status).toBe('pending')
		})

		it('keeps tool_exec status when there are remaining tool calls', () => {
			const agentId = generateTestAgentId()
			const toolCallId1 = generateToolCallId()
			const toolCallId2 = generateToolCallId()

			let session = applyEvent(
				baseSession,
				withSessionId(
					SESSION_ID,
					agentEvents.create('agent_spawned', {
						agentId,
						definitionName: 'test',
						parentId: null,
					}),
				),
			)

			session = applyEvent(
				session,
				withSessionId(
					SESSION_ID,
					llmEvents.create('inference_completed', {
						agentId,
						consumedMessageIds: [],
						response: {
							content: null,
							toolCalls: [
								{ id: toolCallId1, name: 'test1', input: {} },
								{ id: toolCallId2, name: 'test2', input: {} },
							],
						},
						metrics: {
							promptTokens: 100,
							completionTokens: 10,
							totalTokens: 110,
							latencyMs: 500,
							model: 'test-model',
						},
					}),
				),
			)

			session = applyEvent(
				session,
				withSessionId(
					SESSION_ID,
					toolEvents.create('tool_completed', {
						agentId,
						toolCallId: toolCallId1,
						result: 'success',
					}),
				),
			)

			const agent = session.agents.get(agentId)!
			expect(agent.pendingToolCalls).toHaveLength(1)
			expect(agent.status).toBe('tool_exec')
		})

		it('stores content in pendingToolResults (deferred to history by inference_completed)', () => {
			const agentId = generateTestAgentId()
			const toolCallId = generateToolCallId()
			const toolTimestamp = Date.now()

			let session = applyEvent(
				baseSession,
				withSessionId(
					SESSION_ID,
					agentEvents.create('agent_spawned', {
						agentId,
						definitionName: 'test',
						parentId: null,
					}),
				),
			)

			session = applyEvent(
				session,
				withSessionId(
					SESSION_ID,
					llmEvents.create('inference_completed', {
						agentId,
						consumedMessageIds: [],
						response: {
							content: null,
							toolCalls: [{ id: toolCallId, name: 'send_message', input: { to: 'agent-1', message: 'hello' } }],
						},
						metrics: {
							promptTokens: 100,
							completionTokens: 10,
							totalTokens: 110,
							latencyMs: 500,
							model: 'test-model',
						},
					}),
				),
			)

			session = applyEvent(session, {
				...withSessionId(
					SESSION_ID,
					toolEvents.create('tool_completed', {
						agentId,
						toolCallId,
						result: 'success message',
					}),
				),
				timestamp: toolTimestamp,
			})

			const agent = session.agents.get(agentId)!

			// Tool result should NOT be in conversationHistory yet (deferred pattern)
			const toolMessage = agent.conversationHistory.find(m => m.role === 'tool')
			expect(toolMessage).toBeUndefined()

			// Check pendingToolResults has full content
			expect(agent.pendingToolResults).toHaveLength(1)
			expect(agent.pendingToolResults[0].toolCallId).toBe(toolCallId)
			expect(agent.pendingToolResults[0].toolName).toBe('send_message')
			expect(agent.pendingToolResults[0].timestamp).toBe(toolTimestamp)
			expect(agent.pendingToolResults[0].isError).toBe(false)
			expect(agent.pendingToolResults[0].content).toBe('success message')
		})

		it('preserves rich content (array) in pendingToolResults', () => {
			const agentId = generateTestAgentId()
			const toolCallId = generateToolCallId()

			let session = applyEvent(
				baseSession,
				withSessionId(
					SESSION_ID,
					agentEvents.create('agent_spawned', {
						agentId,
						definitionName: 'test',
						parentId: null,
					}),
				),
			)

			session = applyEvent(
				session,
				withSessionId(
					SESSION_ID,
					llmEvents.create('inference_completed', {
						agentId,
						consumedMessageIds: [],
						response: {
							content: null,
							toolCalls: [{ id: toolCallId, name: 'read_file', input: { path: '/test' } }],
						},
						metrics: {
							promptTokens: 100,
							completionTokens: 10,
							totalTokens: 110,
							latencyMs: 500,
							model: 'test-model',
						},
					}),
				),
			)

			// Rich content array (like image + text)
			const richContent = [
				{ type: 'text' as const, text: 'File contents:' },
				{ type: 'image_url' as const, imageUrl: { url: 'data:image/png;base64,abc123' } },
			]

			session = applyEvent(
				session,
				withSessionId(
					SESSION_ID,
					toolEvents.create('tool_completed', {
						agentId,
						toolCallId,
						result: richContent,
					}),
				),
			)

			const agent = session.agents.get(agentId)!

			// Rich content should be preserved (not stringified)
			expect(agent.pendingToolResults[0].content).toEqual(richContent)
		})

		it('inference_started does NOT clear pendingToolResults (deferred to inference_completed)', () => {
			const agentId = generateTestAgentId()
			const toolCallId = generateToolCallId()

			let session = applyEvent(
				baseSession,
				withSessionId(
					SESSION_ID,
					agentEvents.create('agent_spawned', {
						agentId,
						definitionName: 'test',
						parentId: null,
					}),
				),
			)

			session = applyEvent(
				session,
				withSessionId(
					SESSION_ID,
					llmEvents.create('inference_completed', {
						agentId,
						consumedMessageIds: [],
						response: {
							content: null,
							toolCalls: [{ id: toolCallId, name: 'send_message', input: {} }],
						},
						metrics: {
							promptTokens: 100,
							completionTokens: 10,
							totalTokens: 110,
							latencyMs: 500,
							model: 'test-model',
						},
					}),
				),
			)

			session = applyEvent(
				session,
				withSessionId(
					SESSION_ID,
					toolEvents.create('tool_completed', {
						agentId,
						toolCallId,
						result: 'success',
					}),
				),
			)

			// Verify pendingToolResults has entry
			expect(session.agents.get(agentId)!.pendingToolResults).toHaveLength(1)

			// Start new inference - should NOT clear pendingToolResults
			session = applyEvent(
				session,
				withSessionId(
					SESSION_ID,
					llmEvents.create('inference_started', {
						agentId,
						messages: [
							{ role: 'tool' as const, toolCallId, toolName: 'send_message', content: 'success', isError: false, timestamp: TIMESTAMP },
						],
						consumedMessageIds: [],
					}),
				),
			)

			// pendingToolResults preserved until inference_completed
			expect(session.agents.get(agentId)!.pendingToolResults).toHaveLength(1)
		})

		it('inference_completed moves pendingToolResults to conversationHistory', () => {
			const agentId = generateTestAgentId()
			const toolCallId = generateToolCallId()
			const toolTimestamp = TIMESTAMP + 1000

			let session = applyEvent(
				baseSession,
				withSessionId(
					SESSION_ID,
					agentEvents.create('agent_spawned', {
						agentId,
						definitionName: 'test',
						parentId: null,
					}),
				),
			)

			// First inference with tool call
			session = applyEvent(
				session,
				withSessionId(
					SESSION_ID,
					llmEvents.create('inference_completed', {
						agentId,
						consumedMessageIds: [],
						response: {
							content: null,
							toolCalls: [{ id: toolCallId, name: 'send_message', input: {} }],
						},
						metrics: {
							promptTokens: 100,
							completionTokens: 10,
							totalTokens: 110,
							latencyMs: 500,
							model: 'test-model',
						},
					}),
				),
			)

			// Tool completes
			session = applyEvent(session, {
				...withSessionId(
					SESSION_ID,
					toolEvents.create('tool_completed', {
						agentId,
						toolCallId,
						result: 'tool result content',
					}),
				),
				timestamp: toolTimestamp,
			})

			// Verify: not in history yet, in pendingToolResults
			let agent = session.agents.get(agentId)!
			expect(agent.conversationHistory.filter(m => m.role === 'tool')).toHaveLength(0)
			expect(agent.pendingToolResults).toHaveLength(1)

			// Start and complete new inference
			session = applyEvent(session, {
				...withSessionId(
					SESSION_ID,
					llmEvents.create('inference_started', {
						agentId,
						messages: [
							{ role: 'tool' as const, toolCallId, toolName: 'send_message', content: 'tool result content', isError: false, timestamp: toolTimestamp },
						],
						consumedMessageIds: [],
					}),
				),
				timestamp: TIMESTAMP + 2000,
			})

			session = applyEvent(session, {
				...withSessionId(
					SESSION_ID,
					llmEvents.create('inference_completed', {
						agentId,
						consumedMessageIds: [],
						response: {
							content: 'Response after tool',
							toolCalls: [],
						},
						metrics: {
							promptTokens: 100,
							completionTokens: 10,
							totalTokens: 110,
							latencyMs: 500,
							model: 'test-model',
						},
					}),
				),
				timestamp: TIMESTAMP + 3000,
			})

			// Verify: pendingToolResults moved to history, then cleared
			agent = session.agents.get(agentId)!
			expect(agent.pendingToolResults).toHaveLength(0)

			const toolMessages = agent.conversationHistory.filter(m => m.role === 'tool')
			expect(toolMessages).toHaveLength(1)

			const toolMessage = toolMessages[0]
			if (toolMessage.role === 'tool') {
				expect(toolMessage.toolCallId).toBe(toolCallId)
				expect(toolMessage.toolName).toBe('send_message')
				expect(toolMessage.content).toBe('tool result content')
				expect(toolMessage.timestamp).toBe(toolTimestamp)
				expect(toolMessage.isError).toBe(false)
			}
		})
	})

	describe('tool_failed', () => {
		it('removes tool call from pending', () => {
			const agentId = generateTestAgentId()
			const toolCallId = generateToolCallId()

			let session = applyEvent(
				baseSession,
				withSessionId(
					SESSION_ID,
					agentEvents.create('agent_spawned', {
						agentId,
						definitionName: 'test',
						parentId: null,
					}),
				),
			)

			session = applyEvent(
				session,
				withSessionId(
					SESSION_ID,
					llmEvents.create('inference_completed', {
						agentId,
						consumedMessageIds: [],
						response: {
							content: null,
							toolCalls: [{ id: toolCallId, name: 'test', input: {} }],
						},
						metrics: {
							promptTokens: 100,
							completionTokens: 10,
							totalTokens: 110,
							latencyMs: 500,
							model: 'test-model',
						},
					}),
				),
			)

			const event = withSessionId(
				SESSION_ID,
				toolEvents.create('tool_failed', {
					agentId,
					toolCallId,
					error: 'Tool error',
				}),
			)

			session = applyEvent(session, event)

			const agent = session.agents.get(agentId)!
			expect(agent.pendingToolCalls).toHaveLength(0)
			expect(agent.status).toBe('pending')
		})

		it('stores error in pendingToolResults with isError=true (deferred to history by inference_completed)', () => {
			const agentId = generateTestAgentId()
			const toolCallId = generateToolCallId()
			const toolTimestamp = Date.now()

			let session = applyEvent(
				baseSession,
				withSessionId(
					SESSION_ID,
					agentEvents.create('agent_spawned', {
						agentId,
						definitionName: 'test',
						parentId: null,
					}),
				),
			)

			session = applyEvent(
				session,
				withSessionId(
					SESSION_ID,
					llmEvents.create('inference_completed', {
						agentId,
						consumedMessageIds: [],
						response: {
							content: null,
							toolCalls: [{ id: toolCallId, name: 'reveal_secret', input: { password: 'test' } }],
						},
						metrics: {
							promptTokens: 100,
							completionTokens: 10,
							totalTokens: 110,
							latencyMs: 500,
							model: 'test-model',
						},
					}),
				),
			)

			session = applyEvent(session, {
				...withSessionId(
					SESSION_ID,
					toolEvents.create('tool_failed', {
						agentId,
						toolCallId,
						error: 'Invalid password',
					}),
				),
				timestamp: toolTimestamp,
			})

			const agent = session.agents.get(agentId)!

			// Tool result should NOT be in conversationHistory yet (deferred pattern)
			const toolMessage = agent.conversationHistory.find(m => m.role === 'tool')
			expect(toolMessage).toBeUndefined()

			// Check pendingToolResults has error content with isError=true
			expect(agent.pendingToolResults).toHaveLength(1)
			expect(agent.pendingToolResults[0].toolCallId).toBe(toolCallId)
			expect(agent.pendingToolResults[0].toolName).toBe('reveal_secret')
			expect(agent.pendingToolResults[0].timestamp).toBe(toolTimestamp)
			expect(agent.pendingToolResults[0].isError).toBe(true)
			expect(agent.pendingToolResults[0].content).toBe('Invalid password')
		})
	})
})

describe('reconstructSessionState', () => {
	it('returns null for empty events array', () => {
		expect(reconstructSessionState([], applyEvent)).toBeNull()
	})

	it('throws error when first event is not session_created', () => {
		const events: DomainEvent[] = [
			withSessionId(SESSION_ID, sessionEvents.create('session_closed', {})),
		]

		expect(() => reconstructSessionState(events, applyEvent)).toThrow(
			'First event must be session_created',
		)
	})

	it('reconstructs session from events', () => {
		const agentId = generateTestAgentId()
		const events: DomainEvent[] = [
			withSessionId(SESSION_ID, sessionEvents.create('session_created', { presetId: 'test-preset' })),
			withSessionId(
				SESSION_ID,
				agentEvents.create('agent_spawned', {
					agentId,
					definitionName: ORCHESTRATOR_ROLE,
					parentId: null,
				}),
			),
		]

		const session = reconstructSessionState(events, applyEvent)

		expect(session).not.toBeNull()
		expect(session!.id).toBe(SESSION_ID)
		expect(session!.agents.size).toBe(1)
		expect(session!.agents.get(agentId)!.definitionName).toBe(ORCHESTRATOR_ROLE)
	})
})

describe('Query helpers', () => {
	describe('getOrchestratorId', () => {
		it('returns orchestrator agent id', () => {
			const orchestratorId = generateTestAgentId()
			const events: DomainEvent[] = [
				withSessionId(SESSION_ID, sessionEvents.create('session_created', { presetId: 'test' })),
				withSessionId(
					SESSION_ID,
					agentEvents.create('agent_spawned', {
						agentId: orchestratorId,
						definitionName: ORCHESTRATOR_ROLE,
						parentId: null,
					}),
				),
			]

			const session = reconstructSessionState(events, applyEvent)!
			expect(getOrchestratorId(session)).toBe(orchestratorId)
		})

		it('returns null when no orchestrator', () => {
			const session = createSessionState(SESSION_ID, 'test', TIMESTAMP)
			expect(getOrchestratorId(session)).toBeNull()
		})
	})

	describe('getCommunicatorId', () => {
		it('returns communicator agent id', () => {
			const communicatorId = generateTestAgentId()
			const events: DomainEvent[] = [
				withSessionId(SESSION_ID, sessionEvents.create('session_created', { presetId: 'test' })),
				withSessionId(
					SESSION_ID,
					agentEvents.create('agent_spawned', {
						agentId: communicatorId,
						definitionName: COMMUNICATOR_ROLE,
						parentId: null,
					}),
				),
			]

			const session = reconstructSessionState(events, applyEvent)!
			expect(getCommunicatorId(session)).toBe(communicatorId)
		})
	})

	describe('getEntryAgentId', () => {
		it('returns communicator when both exist', () => {
			const orchestratorId = generateTestAgentId()
			const communicatorId = generateTestAgentId()
			const events: DomainEvent[] = [
				withSessionId(SESSION_ID, sessionEvents.create('session_created', { presetId: 'test' })),
				withSessionId(
					SESSION_ID,
					agentEvents.create('agent_spawned', {
						agentId: orchestratorId,
						definitionName: ORCHESTRATOR_ROLE,
						parentId: null,
					}),
				),
				withSessionId(
					SESSION_ID,
					agentEvents.create('agent_spawned', {
						agentId: communicatorId,
						definitionName: COMMUNICATOR_ROLE,
						parentId: orchestratorId,
					}),
				),
			]

			const session = reconstructSessionState(events, applyEvent)!
			expect(getEntryAgentId(session)).toBe(communicatorId)
		})

		it('returns orchestrator when no communicator', () => {
			const orchestratorId = generateTestAgentId()
			const events: DomainEvent[] = [
				withSessionId(SESSION_ID, sessionEvents.create('session_created', { presetId: 'test' })),
				withSessionId(
					SESSION_ID,
					agentEvents.create('agent_spawned', {
						agentId: orchestratorId,
						definitionName: ORCHESTRATOR_ROLE,
						parentId: null,
					}),
				),
			]

			const session = reconstructSessionState(events, applyEvent)!
			expect(getEntryAgentId(session)).toBe(orchestratorId)
		})
	})

	describe('getAgentState', () => {
		it('returns agent by id', () => {
			const agentId = generateTestAgentId()
			const events: DomainEvent[] = [
				withSessionId(SESSION_ID, sessionEvents.create('session_created', { presetId: 'test' })),
				withSessionId(
					SESSION_ID,
					agentEvents.create('agent_spawned', {
						agentId,
						definitionName: 'test',
						parentId: null,
					}),
				),
			]

			const session = reconstructSessionState(events, applyEvent)!
			const agent = getAgentState(session, agentId)

			expect(agent).not.toBeNull()
			expect(agent!.id).toBe(agentId)
		})

		it('returns null for unknown agent', () => {
			const session = createSessionState(SESSION_ID, 'test', TIMESTAMP)
			expect(getAgentState(session, generateTestAgentId())).toBeNull()
		})
	})
})

describe('Immutability', () => {
	it('applyEvent does not mutate original session', () => {
		const session = createSessionState(SESSION_ID, 'test', TIMESTAMP)
		const agentId = generateTestAgentId()

		const event = withSessionId(
			SESSION_ID,
			agentEvents.create('agent_spawned', {
				agentId,
				definitionName: 'test',
				parentId: null,
			}),
		)

		const newSession = applyEvent(session, event)

		expect(session.agents.size).toBe(0)
		expect(newSession.agents.size).toBe(1)
		expect(session).not.toBe(newSession)
	})
})
