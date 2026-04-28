/**
 * Plugin hook result types — return types for agent lifecycle hooks.
 */

import type { ToolResultContent } from '~/core/llm/llm-log-types.js'
import type { LLMResponse, LLMToolCall } from '~/core/llm/state.js'

export type OnStartResult =
	| null
	| { action: 'pause'; reason?: string }

export type BeforeInferenceResult =
	| null
	| { action: 'skip'; response: LLMResponse }
	| { action: 'pause'; reason?: string }

export type AfterInferenceResult =
	| null
	| { action: 'modify'; response: LLMResponse }
	| { action: 'retry' }
	| { action: 'pause'; reason?: string }

export type BeforeToolCallResult =
	| null
	| { action: 'block'; reason: string }
	| { action: 'replace'; toolCall: LLMToolCall }
	| { action: 'pause'; reason?: string }

export type AfterToolCallResult =
	| null
	| { action: 'modify'; result: { isError: boolean; content: ToolResultContent } }
	| { action: 'pause'; reason?: string }

export type OnCompleteResult =
	| null
	| { action: 'pause'; reason?: string }

export type OnErrorResult =
	| null
	| { action: 'pause'; reason?: string }

export type HandlerName =
	| 'onStart'
	| 'beforeInference'
	| 'afterInference'
	| 'beforeToolCall'
	| 'afterToolCall'
	| 'onComplete'
	| 'onError'
