/**
 * Service Status Prompt Builder
 *
 * Builds a system message section describing the current state
 * of session services for injection into agent context.
 */

import type { ServiceConfig, ServiceEntry } from '~/plugins/services/schema.js'

/**
 * Build a service status message for agent context.
 * Returns null if there are no services to show.
 */
export function buildServiceStatusMessage(
	services: ServiceEntry[],
	configs: ServiceConfig[],
): string | null {
	if (services.length === 0 && configs.length === 0) return null

	const configMap = new Map(configs.map((c) => [c.type, c]))
	const lines: string[] = [
		'## Session Services',
		'',
	]

	// Show all configured services (with runtime status if available)
	const serviceMap = new Map(services.map((s) => [s.serviceType, s]))

	for (const config of configs) {
		const entry = serviceMap.get(config.type)
		const status = entry?.status ?? 'stopped'
		let line = `- ${config.type}: ${config.description} — ${status}`

		if (
			entry?.port !== undefined
			&& entry.status !== 'stopped'
			&& entry.status !== 'failed'
			&& entry.status !== 'paused'
		) {
			line += ` (port ${entry.port})`
		}
		if (entry?.error) {
			line += ` (error: ${entry.error})`
		}

		lines.push(line)
	}

	lines.push('')
	lines.push('Use service tools (service_start, service_stop, service_restart, service_status, service_logs) to manage these services.')

	return lines.join('\n')
}
