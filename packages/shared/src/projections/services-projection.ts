/**
 * Services projection - tracks service states from events.
 *
 * Replaces selectPluginState(sessionState, 'services') for client-side use.
 * Handles service_status_changed and session_restarted events.
 */

import type { ServiceStatus } from '@roj-ai/sdk'
export type { ServiceStatus } from '@roj-ai/sdk'
import type { ProjectionEvent } from './events.js'

export interface ServiceEntry {
	serviceType: string
	status: ServiceStatus
	port?: number
	error?: string
	startedAt?: number
	readyAt?: number
	stoppedAt?: number
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
					startedAt: event.timestamp,
				})
			} else if (existing) {
				const updated: ServiceEntry = {
					...existing,
					status: event.toStatus,
				}
				if (event.toStatus === 'starting') {
					updated.startedAt = event.timestamp
					updated.error = undefined
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
				}
				newServices.set(event.serviceType, updated)
			}

			return { ...state, services: newServices }
		}

		case 'session_restarted': {
			let changed = false
			const newServices = new Map(state.services)
			for (const [serviceType, entry] of state.services) {
				if (entry.status === 'starting' || entry.status === 'ready') {
					newServices.set(serviceType, {
						...entry,
						status: 'stopped',
						port: undefined,
						stoppedAt: event.timestamp,
					})
					changed = true
				}
			}
			return changed ? { ...state, services: newServices } : state
		}

		default:
			return state
	}
}
