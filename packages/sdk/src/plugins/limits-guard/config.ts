// ============================================================================
// Agent Limits
// ============================================================================

/**
 * Anti-looping limits for agents.
 * All fields are optional - defaults applied via resolveAgentLimits().
 */
export interface AgentLimits {
	/** Maximum number of inference turns. Default: 100 */
	maxTurns?: number
	/** Maximum total tool calls. Default: 200 */
	maxToolCalls?: number
	/** Maximum consecutive failures for the same tool before blocking. Default: 3 */
	maxConsecutiveToolFailures?: number
	/** Maximum child agents this agent can spawn. Default: 10 */
	maxSpawnedAgents?: number
	/** Maximum messages sent to other agents. Default: 100 */
	maxMessagesSent?: number
	/** Ratio of hard limit at which soft warning is emitted. Default: 0.8 */
	softLimitRatio?: number
	/** Maximum consecutive identical tool calls (same name+input hash). Default: 3 */
	maxRepeatedToolCalls?: number
	/** Maximum consecutive identical text-only responses. Default: 3 */
	maxRepeatedResponses?: number
	/**
	 * Maximum cumulative LLM cost (USD) this agent may spend before it is paused.
	 * Spend is summed from `inference_completed` metrics and, unlike the counter
	 * limits, is NOT reset on resume. Default: unlimited.
	 */
	maxCost?: number
	/**
	 * Maximum cumulative total tokens (prompt + completion) this agent may consume
	 * before it is paused. Useful as a fallback when providers don't report cost.
	 * Not reset on resume. Default: unlimited.
	 */
	maxTokens?: number
	/**
	 * Maximum number of context compaction events for this agent before it is paused.
	 * Guards against pathological compaction loops. Reset on resume. Default: unlimited.
	 */
	maxCompactions?: number
}

// ============================================================================
// Session Limits (budget across all agents)
// ============================================================================

/**
 * Session-wide budget, summed across every agent in the session. Configured via
 * the plugin's session-level config (`pluginConfig`), independent of per-agent
 * limits. All fields optional - defaults applied via resolveSessionLimits().
 */
export interface LimitsSessionConfig {
	/** Maximum cumulative LLM cost (USD) across all agents. Default: unlimited */
	maxSessionCost?: number
	/** Maximum cumulative total tokens across all agents. Default: unlimited */
	maxSessionTokens?: number
	/** Ratio of the session budget at which a soft warning is emitted. Default: 0.8 */
	softLimitRatio?: number
}
