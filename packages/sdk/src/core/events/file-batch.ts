import { createHash } from 'node:crypto'
import z from 'zod/v4'
import { domainEventSchema } from '~/core/sessions/schema.js'
import type { SessionId } from '~/core/sessions/schema.js'
import { isDomainEvent, type DomainEvent } from './types.js'
import { EventLogCorruptionError } from './event-store.js'

const envelopeSchema = z
	.object({
		version: z.literal(1),
		batch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
		byteLength: z.number().int().nonnegative(),
		sha256: z.string(),
		payload: z.string(),
	})
	.strict()

export function batchName(batch: number): string {
	if (!Number.isSafeInteger(batch) || batch < 0) throw new Error('Batch sequence exhausted')
	return `${batch.toString(16).padStart(16, '0')}.json`
}

/** Recovery selects batches positively: a foreign file is not a missing batch. */
export function isBatchName(name: string): boolean {
	return /^[0-9a-f]{16}\.json$/.test(name)
}

function checksum(payload: string): string {
	return createHash('sha256').update(payload, 'utf8').digest('hex')
}

export function parseEvent(value: unknown, sessionId: SessionId): DomainEvent {
	const parsed = domainEventSchema.parse(value)
	if (!isDomainEvent(parsed) || parsed.sessionId !== sessionId) throw new Error('Invalid event session')
	return parsed
}

export function encodeBatch(batch: number, events: DomainEvent[]): string {
	const payload = JSON.stringify(events)
	return JSON.stringify({ version: 1, batch, byteLength: Buffer.byteLength(payload, 'utf8'), sha256: checksum(payload), payload })
}

export function decodeBatch(content: string, batch: number, sessionId: SessionId, path: string): DomainEvent[] {
	try {
		const envelope = envelopeSchema.parse(JSON.parse(content))
		if (
			envelope.batch !== batch ||
			envelope.byteLength !== Buffer.byteLength(envelope.payload, 'utf8') ||
			envelope.sha256 !== checksum(envelope.payload)
		)
			throw new Error('Batch integrity mismatch')
		const values: unknown = JSON.parse(envelope.payload)
		if (!Array.isArray(values) || values.length === 0) throw new Error('Empty or invalid batch')
		return values.map((value: unknown) => parseEvent(value, sessionId))
	} catch (cause) {
		throw new EventLogCorruptionError(sessionId, path, cause)
	}
}
