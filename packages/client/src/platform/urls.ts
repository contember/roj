/**
 * Convert an instance UUID to its full 32-char hex representation (no hyphens, lowercase).
 */
export function instanceIdToHex(instanceId: string): string {
	return instanceId.replace(/-/g, '').toLowerCase()
}

export interface BuildPreviewUrlOptions {
	instanceId: string
	code: string
	baseDomain: string
	/** Optional instance token appended as ?token= for auth */
	token?: string
	/** Platform URL for path-based preview (used when subdomains aren't available) */
	platformUrl?: string
}

/**
 * Build a dev preview URL for a service running in a roj sandbox.
 *
 * Production: https://dev-{slug}-{code}.{baseDomain}/
 * Local dev:  {platformUrl}/api/v1/instances/{id}/preview/{code}/
 */
export function buildPreviewUrl({ instanceId, code, baseDomain, token, platformUrl }: BuildPreviewUrlOptions): string {
	// Cloudflare quick tunnels are already subdomains — can't nest further
	if (baseDomain.includes('trycloudflare.com') && platformUrl) {
		const base = `${platformUrl}/api/v1/instances/${instanceId}/preview/${code}`
		return token ? `${base}/?token=${encodeURIComponent(token)}` : base
	}

	// Subdomain-based: dev-{hex}-{code}.{baseDomain}
	// Works on localhost (*.localhost resolves to 127.0.0.1) and production
	const hex = instanceIdToHex(instanceId)
	const protocol = baseDomain.includes('localhost') ? 'http' : 'https'
	const base = `${protocol}://dev-${hex}-${code}.${baseDomain}`
	return token ? `${base}/?token=${encodeURIComponent(token)}` : base
}

export interface BuildWsUrlOptions {
	platformUrl: string
	instanceId: string
	sessionId: string
	token: string
}

/**
 * Build a WebSocket URL for connecting to a roj instance.
 */
export function buildWsUrl({ platformUrl, instanceId, sessionId, token }: BuildWsUrlOptions): string {
	const url = new URL(`/api/v1/instances/${instanceId}/ws`, platformUrl)
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
	url.searchParams.set('token', token)
	url.searchParams.set('sessionId', sessionId)
	return url.toString()
}

/**
 * Build the RPC base URL for a roj instance.
 */
export function buildApiBaseUrl(platformUrl: string, instanceId: string): string {
	return `${platformUrl}/api/v1/instances/${instanceId}`
}
