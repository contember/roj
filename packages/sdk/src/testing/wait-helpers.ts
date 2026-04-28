import type { AgentId } from '~/core/agents/schema.js'
import type { Session } from '~/core/sessions/session.js'

const DEFAULT_TIMEOUT_MS = 5000
const POLL_INTERVAL_MS = 10

/**
 * Wait for a specific agent to become idle.
 * An agent is "idle" when: status === 'pending', no pendingToolCalls,
 * no pendingToolResults, and not scheduled for processing.
 */
export async function waitForAgentIdle(
	session: Session,
	agentId: AgentId,
	opts?: { timeoutMs?: number },
): Promise<void> {
	const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
	const deadline = Date.now() + timeoutMs

	while (Date.now() < deadline) {
		if (isAgentIdle(session, agentId)) {
			// Double-check after one poll interval to account for queueMicrotask re-entry
			await sleep(POLL_INTERVAL_MS)
			if (isAgentIdle(session, agentId)) {
				return
			}
		}
		await sleep(POLL_INTERVAL_MS)
	}

	throw new Error(`waitForAgentIdle timed out after ${timeoutMs}ms for agent ${agentId}`)
}

/**
 * Wait for all agents in a session to become idle.
 */
export async function waitForAllAgentsIdle(
	session: Session,
	opts?: { timeoutMs?: number },
): Promise<void> {
	const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
	const deadline = Date.now() + timeoutMs

	while (Date.now() < deadline) {
		if (areAllAgentsIdle(session)) {
			// Double-check after one poll interval
			await sleep(POLL_INTERVAL_MS)
			if (areAllAgentsIdle(session)) {
				return
			}
		}
		await sleep(POLL_INTERVAL_MS)
	}

	throw new Error(`waitForAllAgentsIdle timed out after ${timeoutMs}ms`)
}

function isAgentIdle(session: Session, agentId: AgentId): boolean {
	const agent = session.getAgent(agentId)
	if (!agent) return true // Agent doesn't exist, consider idle

	const agentState = agent.state
	if (!agentState) return true

	return (
		agentState.status === 'pending'
		&& agentState.pendingToolCalls.length === 0
		&& agentState.pendingToolResults.length === 0
		&& !agent.isScheduled()
	)
}

function areAllAgentsIdle(session: Session): boolean {
	for (const [agentId] of session.state.agents) {
		if (!isAgentIdle(session, agentId)) {
			return false
		}
	}
	return true
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}
