/**
 * Tests for handler-related event handling in session state
 */

import { describe, expect, it } from 'bun:test'
import { AgentId } from '~/core/agents/schema.js'
import { agentEvents } from '~/core/agents/state.js'
import { withSessionId } from '~/core/events/test-helpers.js'
import { applyEvent } from '~/core/sessions/apply-event.js'
import { SessionId } from '~/core/sessions/schema.js'
import type { SessionState } from '~/core/sessions/state.js'
import { createSessionState } from '~/core/sessions/state.js'

const TEST_SESSION_ID = SessionId('test-session')
const TEST_AGENT_ID = AgentId('test-agent-1')

function createBaseState(): SessionState {
	return createSessionState(TEST_SESSION_ID, 'test-preset', Date.now())
}

describe('Handler Events in Session State', () => {
	describe('agent_spawned with typedInput', () => {
		it('should store typedInput in agent state', () => {
			const state = createBaseState()

			const event = withSessionId(
				TEST_SESSION_ID,
				agentEvents.create('agent_spawned', {
					agentId: TEST_AGENT_ID,
					definitionName: 'calculator',
					parentId: null,
					typedInput: { operation: 'add', a: 5, b: 3 },
				}),
			)

			const newState = applyEvent(state, event)

			const agent = newState.agents.get(TEST_AGENT_ID)
			expect(agent).toBeDefined()
			expect(agent?.typedInput).toEqual({ operation: 'add', a: 5, b: 3 })
		})

		it('should have undefined typedInput when not provided', () => {
			const state = createBaseState()

			const event = withSessionId(
				TEST_SESSION_ID,
				agentEvents.create('agent_spawned', {
					agentId: TEST_AGENT_ID,
					definitionName: 'simple-agent',
					parentId: null,
				}),
			)

			const newState = applyEvent(state, event)

			const agent = newState.agents.get(TEST_AGENT_ID)
			expect(agent).toBeDefined()
			expect(agent?.typedInput).toBeUndefined()
		})
	})

	describe('handler_completed event', () => {
		it('should set onStartCalled when onStart handler completes with continue', () => {
			let state = createBaseState()

			// First spawn the agent
			const spawnEvent = withSessionId(
				TEST_SESSION_ID,
				agentEvents.create('agent_spawned', {
					agentId: TEST_AGENT_ID,
					definitionName: 'test-agent',
					parentId: null,
				}),
			)
			state = applyEvent(state, spawnEvent)

			// Agent should not have onStartCalled yet
			expect(state.agents.get(TEST_AGENT_ID)?.onStartCalled).toBeUndefined()

			// Now complete onStart handler
			const handlerEvent = withSessionId(
				TEST_SESSION_ID,
				agentEvents.create('handler_completed', {
					agentId: TEST_AGENT_ID,
					handlerName: 'onStart',
					result: null,
				}),
			)
			state = applyEvent(state, handlerEvent)

			// Agent should now have onStartCalled = true
			expect(state.agents.get(TEST_AGENT_ID)?.onStartCalled).toBe(true)
		})

		it('should inject preamble messages when preamble_added event is emitted', () => {
			let state = createBaseState()

			state = applyEvent(
				state,
				withSessionId(
					TEST_SESSION_ID,
					agentEvents.create('agent_spawned', {
						agentId: TEST_AGENT_ID,
						definitionName: 'test-agent',
						parentId: null,
					}),
				),
			)

			// Preamble and conversation should be empty
			expect(state.agents.get(TEST_AGENT_ID)?.preamble).toHaveLength(0)
			expect(state.agents.get(TEST_AGENT_ID)?.conversationHistory).toHaveLength(0)

			// Emit preamble_added event
			const preambleEvent = withSessionId(
				TEST_SESSION_ID,
				agentEvents.create('preamble_added', {
					agentId: TEST_AGENT_ID,
					messages: [
						{ role: 'user', content: 'Initial preamble message' },
					],
				}),
			)
			state = applyEvent(state, preambleEvent)

			// Should have message in preamble, not conversationHistory
			const agent = state.agents.get(TEST_AGENT_ID)
			expect(agent?.preamble).toHaveLength(1)
			expect(agent?.preamble[0].role).toBe('user')
			if (agent?.preamble[0].role === 'user') {
				expect(agent.preamble[0].content).toBe('Initial preamble message')
			}
			expect(agent?.conversationHistory).toHaveLength(0)
		})

		it('should not modify state for other handler types', () => {
			let state = createBaseState()

			// Spawn agent
			const spawnEvent = withSessionId(
				TEST_SESSION_ID,
				agentEvents.create('agent_spawned', {
					agentId: TEST_AGENT_ID,
					definitionName: 'test-agent',
					parentId: null,
				}),
			)
			state = applyEvent(state, spawnEvent)

			// Execute beforeInference handler
			const handlerEvent = withSessionId(
				TEST_SESSION_ID,
				agentEvents.create('handler_completed', {
					agentId: TEST_AGENT_ID,
					handlerName: 'beforeInference',
					result: null,
				}),
			)
			state = applyEvent(state, handlerEvent)

			// Agent state should be unchanged (no onStartCalled)
			const agent = state.agents.get(TEST_AGENT_ID)
			expect(agent?.onStartCalled).toBeUndefined()
		})
	})
})
