import type { AgentContext } from '../agents/context.js'
import type { ToolCallId } from './schema.js'

export type ToolContext = AgentContext & {
	/** The call being executed. `agentState` is captured before it starts, so it cannot tell you this. */
	toolCallId: ToolCallId
}
