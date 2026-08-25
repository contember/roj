/**
 * Error responses shared by the HTTP routes.
 *
 * Every route used to hand-write `{ error: { type, message } }` inline — four
 * copies of the session 404 and four of the parse 400 — so nothing enforced the
 * envelope and a client parsing errors had no single contract to code against.
 * The status codes and the `type` strings are the wire contract; keep them here.
 */
import type { DomainError } from '~/core/errors.js'
import type { AppContext } from './context.js'

export const sessionNotFound = (c: AppContext, sessionId: string) =>
	c.json({ error: { type: 'session_not_found', message: `Session not found: ${sessionId}` } }, 404)

/** 400 is the checked id constructor's own status; the rejected value is deliberately not echoed back. */
export const invalidSessionId = (c: AppContext, error: DomainError) =>
	c.json({ error: { type: error.type, message: error.message } }, 400)

export const parseError = (c: AppContext, message: string) =>
	c.json({ error: { type: 'parse_error', message } }, 400)
