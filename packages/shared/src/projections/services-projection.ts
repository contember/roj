/**
 * Services projection - tracks service states from events.
 *
 * Replaces selectPluginState(sessionState, 'services') for client-side use.
 * Handles service_status_changed and session_restarted events.
 */

import type { ServiceStatus, ServiceStoppedBy } from '@roj-ai/sdk'
export type { ServiceStatus, ServiceStoppedBy } from '@roj-ai/sdk'
import type { ProjectionEvent } from './events.js'

export interface ServiceEntry {
	serviceType: string
	status: ServiceStatus
	/**
	 * Who stopped the service — `never` while it has not been stopped since its
	 * last start. An idle eviction stops services and the rebuilt runtime starts
	 * them again, so this is what separates a parked service from one somebody
	 * deliberately shut down.
	 */
	stoppedBy: ServiceStoppedBy
	port?: number
	error?: string
	startedAt?: number
	readyAt?: number
	stoppedAt?: number
	/**
	 * Epoch ms of a queued automatic restart — `failed` with this set means the
	 * service is down but coming back, not down for good. Cleared by the next
	 * status change.
	 */
	restartAt?: number
	restartAttempt?: number
	restartMaxRetries?: number
}

export interface ServicesProjectionState {
	services: Map<string, ServiceEntry>
}

export function createServicesProjectionState(): ServicesProjectionState {
	return { services: new Map() }
}

export function applyEventToServices(state: ServicesProjectionState, event: ProjectionEvent): ServicesProjectionState {
	switch (event.type) {
		case 'service_status_changed': {
			const newServices = new Map(state.services)
			const existing = newServices.get(event.serviceType)

			if (!existing && event.toStatus === 'starting') {
				newServices.set(event.serviceType, {
					serviceType: event.serviceType,
					status: event.toStatus,
					stoppedBy: 'never',
					port: event.port,
					startedAt: event.timestamp,
				})
			} else if (existing) {
				const updated: ServiceEntry = {
					...existing,
					status: event.toStatus,
					// A queued revival lives only until the next status change.
					restartAt: event.restartAt,
					restartAttempt: event.restartAttempt,
					restartMaxRetries: event.restartMaxRetries,
				}
				if (event.toStatus === 'starting') {
					updated.startedAt = event.timestamp
					updated.stoppedBy = 'never'
					updated.error = undefined
					// Assigned, not merged: a restart without a port must clear the old one.
					updated.port = event.port
				}
				if (event.toStatus === 'ready') {
					updated.readyAt = event.timestamp
					if (event.port !== undefined) {
						updated.port = event.port
					}
				}
				if (event.toStatus === 'failed' && event.error) {
					updated.error = event.error
				}
				if (event.toStatus === 'stopped') {
					updated.stoppedAt = event.timestamp
					// Absent in logs written before the discriminator existed.
					updated.stoppedBy = event.stoppedBy ?? 'agent'
				}
				newServices.set(event.serviceType, updated)
			}

			return { ...state, services: newServices }
		}

		case 'session_restarted': {
			let changed = false
			const newServices = new Map(state.services)
			for (const [serviceType, entry] of state.services) {
				// `stopping` counts as live: a runtime that died mid-stop leaves it
				// behind and no other path ever clears it.
				const live = entry.status === 'starting' || entry.status === 'ready' || entry.status === 'stopping'
				// Any queued revival died with the runtime that held its timer.
				if (!live && entry.restartAt === undefined) continue

				const updated: ServiceEntry = {
					...entry,
					restartAt: undefined,
					restartAttempt: undefined,
					restartMaxRetries: undefined,
				}
				if (live) {
					updated.status = 'stopped'
					// The runtime died under it — nobody decided to stop it.
					updated.stoppedBy = 'eviction'
					updated.port = undefined
					updated.stoppedAt = event.timestamp
				}
				newServices.set(serviceType, updated)
				changed = true
			}
			return changed ? { ...state, services: newServices } : state
		}

		default:
			return state
	}
}
