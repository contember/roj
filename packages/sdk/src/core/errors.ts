/**
 * Self-describing domain errors.
 *
 * Each error carries its own HTTP status and message — no central switch needed.
 * Plugins can define any error type they want without touching central files.
 */

// ============================================================================
// Base interface
// ============================================================================

export interface DomainError {
	readonly type: string
	readonly message: string
	readonly httpStatus: number
}

export function createDomainError(type: string, message: string, httpStatus: number): DomainError {
	return { type, message, httpStatus }
}

export function isDomainError(value: unknown): value is DomainError {
	return typeof value === 'object'
		&& value !== null
		&& 'type' in value
		&& typeof value.type === 'string'
		&& 'message' in value
		&& typeof value.message === 'string'
		&& 'httpStatus' in value
		&& typeof value.httpStatus === 'number'
}

// ============================================================================
// Core error factories
// ============================================================================

export const SessionErrors = {
	notFound: (id: string) => createDomainError('session_not_found', `Session not found: ${id}`, 404),
	closed: (id: string) => createDomainError('session_closed', `Session is closed: ${id}`, 409),
	alreadyExists: (id: string) => createDomainError('session_already_exists', `Session already exists: ${id}`, 409),
}

export const AgentErrors = {
	notFound: (id: string) => createDomainError('agent_not_found', `Agent not found: ${id}`, 404),
	invalidState: (id: string, currentState: string, expectedState: string) =>
		createDomainError('invalid_agent_state', `Agent ${id} in invalid state: ${currentState}, expected: ${expectedState}`, 409),
}

export const PresetErrors = {
	notFound: (id: string) => createDomainError('preset_not_found', `Preset not found: ${id}`, 404),
}

export const ValidationErrors = {
	invalid: (message: string) => createDomainError('validation_error', message, 400),
}
