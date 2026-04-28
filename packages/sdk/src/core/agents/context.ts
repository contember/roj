import { SessionContext } from '../sessions/context'
import { AgentConfig } from './agent'
import { AgentId } from './schema'
import { AgentState } from './state'

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
