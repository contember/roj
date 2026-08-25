/**
 * Conformance: the services projection in @roj-ai/shared MUST match the services
 * plugin reducer in @roj-ai/sdk. The sdk cannot import the shared projection
 * (project-reference cycle: shared already references sdk for types), so the
 * transition logic exists twice — this test replays identical event sequences
 * through both and fails on any divergence.
 *
 * Written after the two silently drifted: `stoppedBy` and the `stopping` case in
 * `session_restarted` landed on the sdk side only, leaving a service that died
 * mid-stop stuck as `stopping` forever in every client.
 *
 * sdk modules are imported from source (../../sdk/src) rather than the package
 * entry so the comparison always runs against live code, not a stale dist build.
 * This file lives outside shared/src on purpose: `bun test` executes it, but it
 * is not part of the shared tsc project (rootDir: src).
 */
import { describe, expect, it } from 'bun:test'
import { z } from 'zod'
import type { DomainEvent } from '../../sdk/src/core/events/types.js'
import { withSessionId } from '../../sdk/src/core/events/test-helpers.js'
import { SessionId } from '../../sdk/src/core/sessions/schema.js'
import { sessionEvents } from '../../sdk/src/core/sessions/state.js'
import type { SessionState } from '../../sdk/src/core/sessions/state.js'
import { createSessionState } from '../../sdk/src/core/sessions/state.js'
import { PortPool } from '../../sdk/src/plugins/services/port-pool.js'
import { serviceEvents, servicePlugin } from '../../sdk/src/plugins/services/plugin.js'
import type { ProjectionEvent } from '../src/projections/events.js'
import { applyEventToServices, createServicesProjectionState } from '../src/projections/services-projection.js'

const sessionId = SessionId('services-conformance')
const sessionState: SessionState = createSessionState(sessionId, 'preset', 0)

/**
 * The fields both sides carry. The sdk entry additionally holds pid/cwd/command,
 * which never reach a client — `z.object` strips them, so the comparison covers
 * exactly the overlap and nothing else.
 */
const entrySchema = z.object({
	serviceType: z.string(),
	status: z.enum(['stopped', 'starting', 'ready', 'stopping', 'failed']),
	stoppedBy: z.enum(['agent', 'eviction', 'never']),
	port: z.number().optional(),
	error: z.string().optional(),
	startedAt: z.number().optional(),
	readyAt: z.number().optional(),
	stoppedAt: z.number().optional(),
	restartAt: z.number().optional(),
	restartAttempt: z.number().optional(),
	restartMaxRetries: z.number().optional(),
})

/** Both sides go through the same schema, so a missing `stoppedBy` fails here rather than silently comparing equal. */
const normalize = (raw: unknown): Record<string, z.infer<typeof entrySchema>> =>
	Object.fromEntries(z.map(z.string(), entrySchema).parse(raw))

const sdkSlice = () => {
	const state = servicePlugin.create({ services: [], portPool: new PortPool() }).state
	if (!state) throw new Error('services plugin exposes no state slice')
	return state
}

const statusChanged = (payload: Parameters<typeof serviceEvents.create<'service_status_changed'>>[1]): DomainEvent =>
	withSessionId(sessionId, serviceEvents.create('service_status_changed', payload))

const sessionRestarted = (): DomainEvent =>
	withSessionId(sessionId, sessionEvents.create('session_restarted', { resetAgentIds: [], clearedToolAgentIds: [] }))

/** Replay one sequence through both reducers, comparing after every event — not just at the end. */
function assertConformant(events: readonly DomainEvent[]): Record<string, z.infer<typeof entrySchema>> {
	const slice = sdkSlice()
	let sdkState: unknown = slice.initialState()
	let sharedState = createServicesProjectionState()

	for (const [index, event] of events.entries()) {
		sdkState = slice.reduce(sdkState, event, sessionState)
		sharedState = applyEventToServices(sharedState, event as ProjectionEvent)

		const sdk = normalize(sdkState)
		const shared = normalize(sharedState.services)
		expect({ afterEvent: index, type: event.type, state: shared }).toEqual({ afterEvent: index, type: event.type, state: sdk })
	}

	return normalize(sharedState.services)
}

describe('services projection conformance', () => {
	it('tracks a plain start → ready → stop lifecycle', () => {
		const final = assertConformant([
			statusChanged({ serviceType: 'web', toStatus: 'starting', port: 3000 }),
			statusChanged({ serviceType: 'web', toStatus: 'ready', port: 3000 }),
			statusChanged({ serviceType: 'web', toStatus: 'stopped', stoppedBy: 'agent' }),
		])
		expect(final.web.status).toBe('stopped')
		expect(final.web.stoppedBy).toBe('agent')
	})

	it('reads a stop written before the discriminator existed as `agent`', () => {
		const final = assertConformant([
			statusChanged({ serviceType: 'web', toStatus: 'starting' }),
			statusChanged({ serviceType: 'web', toStatus: 'stopped' }),
		])
		// The only default that cannot resurrect a service somebody meant to stay down.
		expect(final.web.stoppedBy).toBe('agent')
	})

	it('resets stoppedBy, error and port on the next start', () => {
		const final = assertConformant([
			statusChanged({ serviceType: 'web', toStatus: 'starting', port: 3000 }),
			statusChanged({ serviceType: 'web', toStatus: 'failed', error: 'boom' }),
			statusChanged({ serviceType: 'web', toStatus: 'stopped', stoppedBy: 'eviction' }),
			statusChanged({ serviceType: 'web', toStatus: 'starting' }),
		])
		expect(final.web.stoppedBy).toBe('never')
		expect(final.web.error).toBeUndefined()
		expect(final.web.port).toBeUndefined()
	})

	it('clears a queued revival on the next status change', () => {
		assertConformant([
			statusChanged({ serviceType: 'web', toStatus: 'starting' }),
			statusChanged({ serviceType: 'web', toStatus: 'failed', error: 'boom', restartAt: 1_000, restartAttempt: 1, restartMaxRetries: 3 }),
			statusChanged({ serviceType: 'web', toStatus: 'starting' }),
		])
	})

	it('reports every live status as evicted when the runtime dies under it', () => {
		for (const live of ['starting', 'ready', 'stopping'] as const) {
			const events: DomainEvent[] = [statusChanged({ serviceType: 'web', toStatus: 'starting', port: 3000 })]
			if (live === 'ready' || live === 'stopping') events.push(statusChanged({ serviceType: 'web', toStatus: 'ready', port: 3000 }))
			if (live === 'stopping') events.push(statusChanged({ serviceType: 'web', toStatus: 'stopping' }))
			events.push(sessionRestarted())

			const final = assertConformant(events)
			expect(final.web.status).toBe('stopped')
			expect(final.web.stoppedBy).toBe('eviction')
			expect(final.web.port).toBeUndefined()
		}
	})

	it('drops a queued revival on restart without touching an already-stopped service', () => {
		const final = assertConformant([
			statusChanged({ serviceType: 'web', toStatus: 'starting' }),
			statusChanged({ serviceType: 'web', toStatus: 'stopped', stoppedBy: 'agent' }),
			statusChanged({ serviceType: 'web', toStatus: 'failed', error: 'boom', restartAt: 1_000, restartAttempt: 1, restartMaxRetries: 3 }),
			sessionRestarted(),
		])
		expect(final.web.restartAt).toBeUndefined()
		// `failed` is not live, so the restart only drops the revival.
		expect(final.web.status).toBe('failed')
		expect(final.web.stoppedBy).toBe('agent')
	})

	it('ignores a non-starting event for a service it has never seen', () => {
		const final = assertConformant([
			statusChanged({ serviceType: 'ghost', toStatus: 'ready', port: 3000 }),
			statusChanged({ serviceType: 'ghost', toStatus: 'stopped' }),
		])
		expect(final).toEqual({})
	})

	it('keeps several services independent across a restart', () => {
		const final = assertConformant([
			statusChanged({ serviceType: 'web', toStatus: 'starting', port: 3000 }),
			statusChanged({ serviceType: 'web', toStatus: 'ready', port: 3000 }),
			statusChanged({ serviceType: 'db', toStatus: 'starting', port: 5432 }),
			statusChanged({ serviceType: 'db', toStatus: 'stopped', stoppedBy: 'agent' }),
			sessionRestarted(),
		])
		expect(final.web.stoppedBy).toBe('eviction')
		expect(final.db.stoppedBy).toBe('agent')
	})
})
