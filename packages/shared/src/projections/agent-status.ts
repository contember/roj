/**
 * Agent status transitions shared by the client-side projections.
 *
 * These MUST mirror the core reducer in @roj-ai/sdk (packages/sdk/src/core/sessions/state.ts).
 * The sdk cannot import this module (project-reference cycle: shared already references sdk
 * for types), so the logic is duplicated there — the conformance test in
 * packages/shared/tests/agent-status-conformance.test.ts keeps the two in lockstep.
 */

export type InternalAgentStatus = 'pending' | 'inferring' | 'tool_exec' | 'errored' | 'paused'

/** After inference_completed: a pause that landed during the in-flight inference wins. */
export function statusAfterInferenceCompleted(current: InternalAgentStatus, toolCallCount: number): InternalAgentStatus {
	return current === 'paused' ? 'paused' : toolCallCount > 0 ? 'tool_exec' : 'pending'
}

/** After tool_completed / tool_failed: a pause raised by a tool hook wins over the recompute. */
export function statusAfterToolResult(current: InternalAgentStatus, remainingToolCalls: number): InternalAgentStatus {
	return current === 'paused' ? 'paused' : remainingToolCalls === 0 ? 'pending' : 'tool_exec'
}

/** After inference_retried: the staged turn was rolled back; a pause is preserved. */
export function statusAfterInferenceRetried(current: InternalAgentStatus): InternalAgentStatus {
	return current === 'paused' ? 'paused' : 'pending'
}

/** After agent_resumed: resume into tool_exec when the pause interrupted a tool turn. */
export function statusAfterResume(pendingToolCallCount: number): InternalAgentStatus {
	return pendingToolCallCount > 0 ? 'tool_exec' : 'pending'
}
