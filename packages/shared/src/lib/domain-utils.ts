/**
 * Domain utility functions for client-side use.
 */

import type { DomainEvent } from '@roj-ai/sdk'

/**
 * Type guard to check if an unknown value is a DomainEvent.
 */
export const isDomainEvent = (event: unknown): event is DomainEvent =>
	typeof event === 'object'
	&& event !== null
	&& 'type' in event
	&& 'sessionId' in event
	&& 'timestamp' in event

/**
 * Helper to normalize content to string (for display/logging).
 */
export const contentToString = (content: string | Array<{ type: string; text?: string }>): string => {
	if (typeof content === 'string') return content
	return content
		.filter((c): c is { type: 'text'; text: string } => c.type === 'text')
		.map((c) => c.text)
		.join('\n')
}
