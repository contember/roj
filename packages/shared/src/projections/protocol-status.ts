/**
 * Protocol status conversion.
 */

import type { DomainAgentStatus, ProtocolAgentStatus } from '@roj-ai/sdk'

/**
 * Convert domain AgentStatus to protocol AgentStatus.
 */
export function toProtocolStatus(status: DomainAgentStatus): ProtocolAgentStatus {
	switch (status) {
		case 'pending':
			return 'idle'
		case 'inferring':
			return 'thinking'
		case 'tool_exec':
			return 'responding'
		case 'errored':
			return 'error'
		case 'paused':
			return 'paused'
	}
}
