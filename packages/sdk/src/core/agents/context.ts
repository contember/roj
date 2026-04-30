import { SessionContext } from '../sessions/context.js'
import { AgentConfig } from './agent.js'
import { AgentId } from './schema.js'
import { AgentState } from './state.js'

export type AgentContext<TInput = unknown> =
	& SessionContext
	& {
		/** The agent's ID */
		agentId: AgentId
		/** The agent's current state */
		agentState: AgentState

		agentConfig: AgentConfig
		/** The typed input if agent has inputSchema, otherwise the task string */
		input: TInput
		/** The parent agent ID (null for root agents) */
		parentId: AgentId | null
	}
