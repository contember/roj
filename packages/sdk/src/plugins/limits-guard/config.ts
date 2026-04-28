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
}
