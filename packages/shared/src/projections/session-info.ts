/**
 * Session info projection - tracks basic session metadata.
 *
 * Extracts session-level information (id, preset, status, timestamps)
 * from lifecycle events without requiring full SessionState.
 */

import type { SessionId } from '@roj-ai/sdk'
import type { ProjectionEvent } from './events.js'

export interface SessionInfoState {
	id: SessionId | null
	presetId: string | null
	status: 'active' | 'closed'
	createdAt: number | null
	closedAt?: number
	workspaceDir?: string
}

export function createSessionInfoState(): SessionInfoState {
	return {
		id: null,
		presetId: null,
		status: 'active',
		createdAt: null,
	}
}

export function applyEventToSessionInfo(state: SessionInfoState, event: ProjectionEvent): SessionInfoState {
	switch (event.type) {
		case 'session_created': {
			return {
				...state,
				id: event.sessionId,
				presetId: event.presetId,
				createdAt: event.timestamp,
				workspaceDir: event.workspaceDir,
			}
		}
		case 'session_closed':
			return { ...state, status: 'closed', closedAt: event.timestamp }
		case 'session_reopened':
			return { ...state, status: 'active', closedAt: undefined }
		default:
			return state
	}
}
