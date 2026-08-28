/**
 * Framing for the liveness probe an agent sends and its host answers.
 *
 * Both directions carry a complete `WireMessage`, and each side reads the other's
 * frame before acting on it: an envelope missing its payload is indistinguishable
 * from silence, which is exactly what the sender's missed-beat count notices.
 */

import type { WireMessage } from '@roj-ai/transport'

export const HEARTBEAT_TYPE = 'heartbeat'
export const HEARTBEAT_ACK_TYPE = 'heartbeat_ack'

/** Send time, so a reader can tell one beat from the next. */
interface HeartbeatPayload {
	ts: number
}

function encode(type: string): string {
	const ts = Date.now()
	const message: WireMessage<HeartbeatPayload> = { type, payload: { ts }, ts }
	return JSON.stringify(message)
}

export const encodeProbe = (): string => encode(HEARTBEAT_TYPE)

export const encodeAck = (): string => encode(HEARTBEAT_ACK_TYPE)

function hasSendTime(payload: unknown): boolean {
	return typeof payload === 'object' && payload !== null && 'ts' in payload && typeof payload.ts === 'number'
}

/** Reads a probe off the wire. An incomplete frame is not one, so it goes unanswered. */
export function isProbeFrame(raw: string): boolean {
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		return false
	}
	if (typeof parsed !== 'object' || parsed === null) return false
	if (!('type' in parsed) || parsed.type !== HEARTBEAT_TYPE) return false
	if (!('ts' in parsed) || typeof parsed.ts !== 'number') return false
	return 'payload' in parsed && hasSendTime(parsed.payload)
}

/** Reads an ack the router has already unwrapped into `(type, payload)`. */
export function isAckFrame(type: string, payload: unknown): boolean {
	return type === HEARTBEAT_ACK_TYPE && hasSendTime(payload)
}
