import type { InferenceResponse, LLMError, LLMMessage } from '~/core/llm/provider.js'
import type { Result } from '~/lib/utils/result.js'
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

		/**
		 * Run a one-off LLM call reusing the agent's current system prompt, tools,
		 * and conversation prefix, with extra trailing messages appended. Lets
		 * plugins do side-channel inferences (e.g. summarization) while sharing
		 * the agent's warm prompt cache. See Agent.runAuxiliaryInference for the
		 * full contract.
		 */
		runAuxiliaryInference: (extraMessages: LLMMessage[]) => Promise<Result<InferenceResponse, LLMError>>
	}
