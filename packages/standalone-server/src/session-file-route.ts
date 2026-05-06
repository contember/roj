/**
 * Token-authenticated session file download route.
 *
 * GET /api/v1/instances/:id/sessions/:sid/files/:scope/{path}?token=...
 *
 * Validates the HMAC token minted by `sessionFiles.createDownloadUrl` against
 * the URL's (instanceId, sessionId, scope, path), then proxies to the SDK's
 * existing `/sessions/:sid/workspace/*` or `/sessions/:sid/files/*` route on
 * the agent app — same shape as roj-platform's `session-file-route.ts`, just
 * served in-process.
 */

import type { Logger } from '@roj-ai/sdk'
import type { Context } from 'hono'
import { verifyFileToken } from './signed-token.js'

// Decoupled from Hono's exact type so the SDK's hono and standalone-server's
// hono — which the workspace can resolve to slightly different versions —
// don't fight over generics. We only need fetch.
interface AgentAppLike {
	fetch: (req: Request) => Response | Promise<Response>
}

interface Deps {
	tokenSecret: string
	agentApp: AgentAppLike
	logger: Logger
}

const SCOPE_TO_SDK_PREFIX: Record<'workspace' | 'session', string> = {
	workspace: 'workspace',
	session: 'files',
}

export function createSessionFileRoute(deps: Deps) {
	return async (c: Context) => {
		const instanceId = c.req.param('id')
		const sessionId = c.req.param('sid')
		const scope = c.req.param('scope') as 'workspace' | 'session'
		const url = new URL(c.req.url)

		const tokenStr = url.searchParams.get('token')
		if (!tokenStr) {
			return c.json({ error: { type: 'unauthorized', message: 'Missing token' } }, 401)
		}

		const verified = verifyFileToken(deps.tokenSecret, tokenStr)
		if (!verified.ok) {
			return c.json({ error: { type: 'unauthorized', message: `Invalid token (${verified.error})` } }, 401)
		}

		// Recover the file path the token was signed for. Hono `*` capture is
		// available via the URL pathname; decode each segment back to its
		// original form so the comparison against the signed payload is exact.
		const pathPrefix = `/api/v1/instances/${instanceId}/sessions/${sessionId}/files/${scope}/`
		if (!url.pathname.startsWith(pathPrefix)) {
			return c.json({ error: { type: 'invalid_request', message: 'Path mismatch' } }, 400)
		}
		const requestedPath = url.pathname
			.slice(pathPrefix.length)
			.split('/')
			.map(seg => decodeURIComponent(seg))
			.join('/')

		const p = verified.payload
		if (
			p.instanceId !== instanceId ||
			p.sessionId !== sessionId ||
			p.scope !== scope ||
			p.path !== requestedPath
		) {
			return c.json(
				{ error: { type: 'unauthorized', message: 'Token does not match requested file' } },
				401,
			)
		}

		// Proxy to the SDK's underlying file route. Note the path/scope mapping:
		// public `workspace` → SDK `/sessions/:sid/workspace/*`,
		// public `session`   → SDK `/sessions/:sid/files/*`.
		const sdkPrefix = SCOPE_TO_SDK_PREFIX[scope]
		const innerUrl = `${url.origin}/sessions/${sessionId}/${sdkPrefix}/${encodePathSegments(requestedPath)}`
		try {
			return await deps.agentApp.fetch(new Request(innerUrl, { method: 'GET' }))
		} catch (err) {
			deps.logger.error('Session file proxy failed', err instanceof Error ? err : new Error(String(err)), {
				instanceId,
				sessionId,
				scope,
				path: requestedPath,
			})
			return c.json({ error: { type: 'proxy_error', message: 'File proxy failed' } }, 502)
		}
	}
}

function encodePathSegments(path: string): string {
	return path.split('/').map(seg => encodeURIComponent(seg)).join('/')
}
