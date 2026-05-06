/**
 * Tiny HMAC-signed download token used by `sessionFiles.createDownloadUrl`.
 *
 * The token binds (instanceId, sessionId, scope, path, expiresAt) so a leaked
 * URL can only fetch the exact file it was minted for, and only briefly. Same
 * shape as roj-platform's `session-file-token.ts`, just pruned for local use.
 */

import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto'

export interface SignedFilePayload {
	instanceId: string
	sessionId: string
	scope: 'workspace' | 'session'
	path: string
	expiresAt: number
}

export function generateTokenSecret(): string {
	return randomBytes(32).toString('hex')
}

export function signFileToken(secret: string, payload: SignedFilePayload): string {
	const body = base64UrlEncode(Buffer.from(JSON.stringify(payload), 'utf8'))
	const sig = base64UrlEncode(hmac(secret, body))
	return `${body}.${sig}`
}

export type VerifyResult =
	| { ok: true; payload: SignedFilePayload }
	| { ok: false; error: 'malformed' | 'bad_signature' | 'expired' }

export function verifyFileToken(secret: string, token: string): VerifyResult {
	const dot = token.indexOf('.')
	if (dot < 0) return { ok: false, error: 'malformed' }
	const body = token.slice(0, dot)
	const sigEncoded = token.slice(dot + 1)

	const expectedSig = hmac(secret, body)
	const givenSig = base64UrlDecode(sigEncoded)
	if (givenSig.length !== expectedSig.length || !timingSafeEqual(givenSig, expectedSig)) {
		return { ok: false, error: 'bad_signature' }
	}

	let payload: SignedFilePayload
	try {
		payload = JSON.parse(base64UrlDecode(body).toString('utf8'))
	} catch {
		return { ok: false, error: 'malformed' }
	}
	if (typeof payload.expiresAt !== 'number' || payload.expiresAt < Date.now()) {
		return { ok: false, error: 'expired' }
	}
	return { ok: true, payload }
}

function hmac(secret: string, body: string): Buffer {
	return createHmac('sha256', secret).update(body).digest()
}

function base64UrlEncode(buf: Buffer): string {
	return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlDecode(s: string): Buffer {
	const pad = '='.repeat((4 - (s.length % 4)) % 4)
	return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64')
}
