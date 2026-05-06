import { useEffect, useMemo } from 'react'
import { useSessionStore } from './stores/session-store.js'
import { buildPreviewUrl } from '@roj-ai/client/platform'

export interface UsePreviewUrlOptions {
	instanceId: string
	baseDomain: string
	/** Instance token appended as ?token= for auth */
	token?: string
	/** Service type to match (default: first available service) */
	serviceType?: string
	/** Platform URL for path-based preview fallback */
	platformUrl?: string
	/**
	 * Force path-based URL construction. Set when the platform doesn't route
	 * wildcard subdomains — primarily `@roj-ai/standalone-server` in local dev.
	 */
	pathBased?: boolean
}

/**
 * Derives a dev preview URL reactively from WebSocket service status updates.
 *
 * Returns `null` until a service with a `code` becomes available.
 * When reconnecting to an existing session, fetches the service URL
 * from the platform via `services.getUrl` RPC if not already in store.
 *
 * @example
 * ```tsx
 * const previewUrl = usePreviewUrl({
 *   instanceId: '...',
 *   baseDomain: 'roj.example.com',
 *   token: instanceToken,
 *   serviceType: 'dev',
 * })
 *
 * if (previewUrl) {
 *   return <iframe src={previewUrl} />
 * }
 * ```
 */
export function usePreviewUrl(options: UsePreviewUrlOptions): string | null {
	const { instanceId, baseDomain, token, serviceType, platformUrl, pathBased } = options
	const services = useSessionStore((s) => s.services)
	const sessionId = useSessionStore((s) => s.sessionId)
	const status = useSessionStore((s) => s.status)
	const fetchServiceUrl = useSessionStore((s) => s.fetchServiceUrl)

	// When the requested service is not yet in the store, fetch from platform (triggers start)
	useEffect(() => {
		if (status !== 'active' || !sessionId || !serviceType) return
		if (services.has(serviceType)) return
		fetchServiceUrl(instanceId, sessionId, serviceType)
	}, [status, services, sessionId, serviceType, instanceId, fetchServiceUrl])

	return useMemo(() => {
		// Find matching service
		let service: { code?: string } | undefined
		if (serviceType) {
			service = services.get(serviceType)
		} else {
			// First available service with a code
			for (const s of services.values()) {
				if (s.code) {
					service = s
					break
				}
			}
		}

		if (!service?.code) return null

		return buildPreviewUrl({ instanceId, code: service.code, baseDomain, token, platformUrl, pathBased })
	}, [instanceId, baseDomain, token, serviceType, platformUrl, pathBased, services])
}
