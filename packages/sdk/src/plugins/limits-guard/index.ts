export type { AgentLimits, LimitsSessionConfig } from './config.js'
export { limitsGuardPlugin } from './plugin.js'
export type { AgentCounters, BudgetExceededEvent, LimitsAgentConfig, LimitWarningEvent } from './plugin.js'
export { createAgentCounters, limitsEvents, sumSessionSpend } from './plugin.js'
