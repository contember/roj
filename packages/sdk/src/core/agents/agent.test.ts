import { describe, expect, it } from 'bun:test'
import { COMMUNICATOR_ROLE, ORCHESTRATOR_ROLE } from '~/core/agents/agent-roles.js'
import { generateTestAgentId } from '~/core/agents/schema.js'
import type { AgentState } from '~/core/agents/state.js'
import { getChildren, getParent } from '~/core/agents/state.js'
import { fromLLMToolCall, fromLLMToolCalls } from '~/core/sessions/state.js'
import { canCommunicateWith, getCommunicableAgents } from '~/plugins/mailbox/helpers.js'
import { formatMailboxForLLM } from '~/plugins/mailbox/prompts.js'
import type { MailboxMessage } from '~/plugins/mailbox/schema.js'
import { generateTestMessageId } from '~/plugins/mailbox/schema.js'

const createTestAgent = (overrides: Partial<AgentState> = {}): AgentState => ({
	id: generateTestAgentId(),
	definitionName: 'test-agent',
	parentId: null,
	status: 'pending',
	conversationHistory: [],
	preamble: [],
	pendingToolCalls: [],
	pendingToolResults: [],
	pendingMessages: [],
	...overrides,
})

const createTestMessage = (
	overrides: Partial<MailboxMessage> = {},
): MailboxMessage => ({
	id: generateTestMessageId(),
	from: 'user',
	content: 'test message',
	timestamp: Date.now(),
	consumed: false,
	...overrides,
})

describe('formatMailboxForLLM', () => {
	it('formats messages with XML tags including timestamp', () => {
		const messages: MailboxMessage[] = [
			createTestMessage({ from: 'user', content: 'Hello', timestamp: 1000 }),
			createTestMessage({
				from: generateTestAgentId(),
				content: 'Hi there',
				timestamp: 2000,
			}),
		]

		const result = formatMailboxForLLM(messages, 3000)

		expect(result).toContain('<message from="user" timestamp="1000">')
		expect(result).toContain('Hello')
		expect(result).toContain('</message>')
		expect(result).toContain('<info>')
		expect(result).toContain('<currentTime>1970-01-01T00:00:03.000Z</currentTime>')
	})

	it('handles agent IDs in from field', () => {
		const agentId = generateTestAgentId()
		const messages: MailboxMessage[] = [
			createTestMessage({ from: agentId, content: 'test' }),
		]

		const result = formatMailboxForLLM(messages)

		expect(result).toContain(`from="${agentId}"`)
	})
})

describe('Agent tree helpers', () => {
	describe('getChildren', () => {
		it('returns children of an agent', () => {
			const parentId = generateTestAgentId()
			const child1 = createTestAgent({ parentId })
			const child2 = createTestAgent({ parentId })
			const other = createTestAgent({ parentId: null })

			const session = {
				agents: new Map([
					[child1.id, child1],
					[child2.id, child2],
					[other.id, other],
				]),
			}

			const children = getChildren(session, parentId)

			expect(children).toHaveLength(2)
			expect(children).toContain(child1)
			expect(children).toContain(child2)
		})

		it('returns empty array when no children', () => {
			const parentId = generateTestAgentId()
			const session = { agents: new Map() }

			expect(getChildren(session, parentId)).toHaveLength(0)
		})
	})

	describe('getParent', () => {
		it('returns parent agent', () => {
			const parent = createTestAgent()
			const child = createTestAgent({ parentId: parent.id })

			const session = {
				agents: new Map([
					[parent.id, parent],
					[child.id, child],
				]),
			}

			expect(getParent(session, child)).toBe(parent)
		})

		it('returns null when no parent', () => {
			const agent = createTestAgent({ parentId: null })
			const session = { agents: new Map([[agent.id, agent]]) }

			expect(getParent(session, agent)).toBeNull()
		})

		it('returns null when parent not found', () => {
			const agent = createTestAgent({ parentId: generateTestAgentId() })
			const session = { agents: new Map([[agent.id, agent]]) }

			expect(getParent(session, agent)).toBeNull()
		})
	})

	describe('canCommunicateWith', () => {
		it('returns true when communicating with parent', () => {
			const parent = createTestAgent()
			const child = createTestAgent({ parentId: parent.id })

			const session = {
				agents: new Map([
					[parent.id, parent],
					[child.id, child],
				]),
			}

			expect(canCommunicateWith(session, child.id, parent.id)).toBe(true)
		})

		it('returns true when communicating with child', () => {
			const parent = createTestAgent()
			const child = createTestAgent({ parentId: parent.id })

			const session = {
				agents: new Map([
					[parent.id, parent],
					[child.id, child],
				]),
			}

			expect(canCommunicateWith(session, parent.id, child.id)).toBe(true)
		})

		it('returns false when communicating with sibling', () => {
			const parent = createTestAgent()
			const child1 = createTestAgent({ parentId: parent.id })
			const child2 = createTestAgent({ parentId: parent.id })

			const session = {
				agents: new Map([
					[parent.id, parent],
					[child1.id, child1],
					[child2.id, child2],
				]),
			}

			expect(canCommunicateWith(session, child1.id, child2.id)).toBe(false)
		})

		it('returns false when fromAgent not found', () => {
			const agent = createTestAgent()
			const session = { agents: new Map([[agent.id, agent]]) }

			expect(canCommunicateWith(session, generateTestAgentId(), agent.id)).toBe(false)
		})

		it('returns false when toAgent not found', () => {
			const agent = createTestAgent()
			const session = { agents: new Map([[agent.id, agent]]) }

			expect(canCommunicateWith(session, agent.id, generateTestAgentId())).toBe(false)
		})

		it('returns true for communicator to orchestrator communication', () => {
			const communicator = createTestAgent({ definitionName: COMMUNICATOR_ROLE, parentId: null })
			const orchestrator = createTestAgent({ definitionName: ORCHESTRATOR_ROLE, parentId: null })

			const session = {
				agents: new Map([
					[communicator.id, communicator],
					[orchestrator.id, orchestrator],
				]),
			}

			expect(canCommunicateWith(session, communicator.id, orchestrator.id)).toBe(true)
		})

		it('returns true for orchestrator to communicator communication', () => {
			const communicator = createTestAgent({ definitionName: COMMUNICATOR_ROLE, parentId: null })
			const orchestrator = createTestAgent({ definitionName: ORCHESTRATOR_ROLE, parentId: null })

			const session = {
				agents: new Map([
					[communicator.id, communicator],
					[orchestrator.id, orchestrator],
				]),
			}

			expect(canCommunicateWith(session, orchestrator.id, communicator.id)).toBe(true)
		})

		it('returns false for unrelated root-level agents', () => {
			const agent1 = createTestAgent({ definitionName: 'researcher', parentId: null })
			const agent2 = createTestAgent({ definitionName: 'coder', parentId: null })

			const session = {
				agents: new Map([
					[agent1.id, agent1],
					[agent2.id, agent2],
				]),
			}

			expect(canCommunicateWith(session, agent1.id, agent2.id)).toBe(false)
		})
	})

	describe('getCommunicableAgents', () => {
		it('returns empty array when agent not found', () => {
			const session = { agents: new Map() }
			expect(getCommunicableAgents(session, generateTestAgentId())).toEqual([])
		})

		it('returns parent when agent has parent', () => {
			const parent = createTestAgent()
			const child = createTestAgent({ parentId: parent.id })

			const session = {
				agents: new Map([
					[parent.id, parent],
					[child.id, child],
				]),
			}

			const result = getCommunicableAgents(session, child.id)
			expect(result).toContain(parent.id)
		})

		it('returns children when agent has children', () => {
			const parent = createTestAgent()
			const child1 = createTestAgent({ parentId: parent.id })
			const child2 = createTestAgent({ parentId: parent.id })

			const session = {
				agents: new Map([
					[parent.id, parent],
					[child1.id, child1],
					[child2.id, child2],
				]),
			}

			const result = getCommunicableAgents(session, parent.id)
			expect(result).toContain(child1.id)
			expect(result).toContain(child2.id)
		})

		it('returns both parent and children', () => {
			const grandparent = createTestAgent()
			const parent = createTestAgent({ parentId: grandparent.id })
			const child = createTestAgent({ parentId: parent.id })

			const session = {
				agents: new Map([
					[grandparent.id, grandparent],
					[parent.id, parent],
					[child.id, child],
				]),
			}

			const result = getCommunicableAgents(session, parent.id)
			expect(result).toHaveLength(2)
			expect(result).toContain(grandparent.id)
			expect(result).toContain(child.id)
		})

		it('does not include siblings', () => {
			const parent = createTestAgent()
			const child1 = createTestAgent({ parentId: parent.id })
			const child2 = createTestAgent({ parentId: parent.id })

			const session = {
				agents: new Map([
					[parent.id, parent],
					[child1.id, child1],
					[child2.id, child2],
				]),
			}

			const result = getCommunicableAgents(session, child1.id)
			expect(result).toHaveLength(1)
			expect(result).toContain(parent.id)
			expect(result).not.toContain(child2.id)
		})

		it('returns orchestrator for communicator (root-level special case)', () => {
			const communicator = createTestAgent({ definitionName: COMMUNICATOR_ROLE, parentId: null })
			const orchestrator = createTestAgent({ definitionName: ORCHESTRATOR_ROLE, parentId: null })

			const session = {
				agents: new Map([
					[communicator.id, communicator],
					[orchestrator.id, orchestrator],
				]),
			}

			const result = getCommunicableAgents(session, communicator.id)
			expect(result).toContain(orchestrator.id)
		})

		it('returns communicator for orchestrator (root-level special case)', () => {
			const communicator = createTestAgent({ definitionName: COMMUNICATOR_ROLE, parentId: null })
			const orchestrator = createTestAgent({ definitionName: ORCHESTRATOR_ROLE, parentId: null })

			const session = {
				agents: new Map([
					[communicator.id, communicator],
					[orchestrator.id, orchestrator],
				]),
			}

			const result = getCommunicableAgents(session, orchestrator.id)
			expect(result).toContain(communicator.id)
		})

		it('does not include other root agents for non-comm/orch agents', () => {
			const agent1 = createTestAgent({ definitionName: 'researcher', parentId: null })
			const agent2 = createTestAgent({ definitionName: 'coder', parentId: null })

			const session = {
				agents: new Map([
					[agent1.id, agent1],
					[agent2.id, agent2],
				]),
			}

			const result = getCommunicableAgents(session, agent1.id)
			expect(result).toHaveLength(0)
		})
	})
})

describe('LLMToolCall conversion', () => {
	describe('fromLLMToolCall', () => {
		it('converts LLMToolCall to ToolCall', () => {
			const toolCallId = 'tc-1' as any
			const llmToolCall = {
				id: toolCallId,
				name: 'test_tool',
				input: { foo: 'bar' },
			}

			const result = fromLLMToolCall(llmToolCall)

			expect(result.id).toBe(toolCallId)
			expect(result.name).toBe('test_tool')
			expect(result.input).toEqual({ foo: 'bar' })
		})
	})

	describe('fromLLMToolCalls', () => {
		it('converts array of LLMToolCalls', () => {
			const llmToolCalls = [
				{ id: 'tc-1' as any, name: 'tool1', input: { a: 1 } },
				{ id: 'tc-2' as any, name: 'tool2', input: { b: 2 } },
			]

			const result = fromLLMToolCalls(llmToolCalls)

			expect(result).toHaveLength(2)
			expect(result[0].input).toEqual({ a: 1 })
			expect(result[1].input).toEqual({ b: 2 })
		})
	})
})
