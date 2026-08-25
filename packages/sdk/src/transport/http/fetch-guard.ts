/**
 * Guard for the two routes that fetch a caller-supplied URL.
 *
 * `upload-from-url` and `inject-resource` are twins: both pull an arbitrary URL
 * from inside the agent host, so an unguarded fetch turns the server into an
 * SSRF proxy onto loopback, RFC1918 and the cloud metadata endpoint — and both
 * reflect the status and the extracted content back to the caller. Every fetch
 * on those paths must go through `safeFetch`, redirects included.
 */

import { lookup } from 'node:dns/promises'
import { type AllowedHostEntry, parseAllowedHostEntry } from '~/config.js'
import { createDomainError, type DomainError } from '~/core/errors.js'
import { Err, Ok } from '~/lib/utils/result.js'
import type { Result } from '~/lib/utils/result.js'

/** Redirect hops followed before giving up. Every hop is re-checked. */
const MAX_REDIRECTS = 5

const fetchError = (message: string): DomainError => createDomainError('fetch_error', message, 400)

export interface FetchGuardOptions {
	/**
	 * Hosts to accept even though they land in a blocked range (e.g. an internal
	 * object store). Omitting it means an empty allowlist, so a caller that
	 * forgets to pass one fails closed. Comes from `Config.remoteFetchAllowedHosts`,
	 * whose `host[:port]` format `parseAllowedHostEntry` owns.
	 */
	allowedHosts?: readonly string[]
	/**
	 * Resolver for a hostname that is not an IP literal, returning every address
	 * it maps to. Defaults to the platform DNS resolver; tests inject their own.
	 */
	resolveHost?: (hostname: string) => Promise<readonly string[]>
}

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/** Parse a dotted-quad literal into its four octets, or null when it is not one. */
function parseIPv4(host: string): number[] | null {
	const match = IPV4_PATTERN.exec(host)
	if (!match) return null
	const octets = match.slice(1).map(part => Number(part))
	return octets.every(octet => octet <= 255) ? octets : null
}

function isBlockedIPv4(octets: readonly number[]): boolean {
	const [a, b, c] = octets
	if (a === 0) return true // 0.0.0.0/8 — reaches the local host on Linux
	if (a === 127) return true // loopback
	if (a === 10) return true // RFC1918
	if (a === 172 && b >= 16 && b <= 31) return true // RFC1918
	if (a === 192 && b === 168) return true // RFC1918
	if (a === 169 && b === 254) return true // link-local, incl. the metadata endpoint
	if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 CGNAT — carries a metadata endpoint too
	if (a === 192 && b === 0 && c === 0) return true // 192.0.0.0/24 IETF protocol assignments
	if (a === 198 && (b === 18 || b === 19)) return true // 198.18.0.0/15 benchmarking
	if (a >= 224) return true // 224.0.0.0/4 multicast plus 240.0.0.0/4 reserved, incl. 255.255.255.255
	return false
}

/** Expand an IPv6 literal to its eight 16-bit groups, or null when it is not one. */
function expandIPv6(host: string): number[] | null {
	const zoneless = host.split('%')[0]
	if (!zoneless.includes(':')) return null

	const halves = zoneless.split('::')
	if (halves.length > 2) return null

	const toGroups = (part: string): number[] | null => {
		if (part === '') return []
		const groups: number[] = []
		const pieces = part.split(':')
		for (const [index, piece] of pieces.entries()) {
			// A trailing dotted quad (`::ffff:1.2.3.4`) fills the last two groups.
			if (index === pieces.length - 1 && piece.includes('.')) {
				const octets = parseIPv4(piece)
				if (!octets) return null
				groups.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3])
				continue
			}
			if (!/^[0-9a-f]{1,4}$/.test(piece)) return null
			groups.push(Number.parseInt(piece, 16))
		}
		return groups
	}

	const head = toGroups(halves[0])
	if (!head) return null
	if (halves.length === 1) return head.length === 8 ? head : null

	const tail = toGroups(halves[1])
	if (!tail) return null
	const fill = 8 - head.length - tail.length
	if (fill < 1) return null
	return [...head, ...Array<number>(fill).fill(0), ...tail]
}

/**
 * The IPv4 destination an IPv6 address really carries, or null when it has none.
 *
 * Every transition mechanism here reaches an IPv4 host, so the address that
 * decides the verdict is the embedded one, not the v6 prefix in front of it.
 */
function embeddedIPv4(groups: readonly number[]): number[] | null {
	const [g0, g1, g2, g3, g4, g5, g6, g7] = groups
	const trailingQuad = [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff]
	const leadingZeros = (count: number) => groups.slice(0, count).every(group => group === 0)

	if (leadingZeros(5) && g5 === 0xffff) return trailingQuad // ::ffff:a.b.c.d IPv4-mapped
	if (leadingZeros(4) && g4 === 0xffff && g5 === 0) return trailingQuad // ::ffff:0:a.b.c.d IPv4-translated
	if (leadingZeros(6)) return trailingQuad // ::a.b.c.d IPv4-compatible, which covers :: and ::1
	if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return trailingQuad // 64:ff9b::/96 NAT64
	if (g0 === 0x2002) return [g1 >> 8, g1 & 0xff, g2 >> 8, g2 & 0xff] // 2002::/16 6to4
	return null
}

function isBlockedIPv6(groups: readonly number[]): boolean {
	const [g0] = groups
	const embedded = embeddedIPv4(groups)
	if (embedded) return isBlockedIPv4(embedded)
	if ((g0 & 0xfe00) === 0xfc00) return true // fc00::/7 unique-local
	if ((g0 & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
	if ((g0 & 0xff00) === 0xff00) return true // ff00::/8 multicast
	return false
}

/** `URL.hostname` keeps the brackets around an IPv6 literal and any trailing root dots. */
function normalizeHost(hostname: string): string {
	const host = hostname.toLowerCase().replace(/\.+$/, '')
	return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

/** Parse a host as an IP literal in either family, or null when it is a name. */
function parseAddress(host: string): { family: 4 | 6; groups: number[] } | null {
	const ipv4 = parseIPv4(host)
	if (ipv4) return { family: 4, groups: ipv4 }
	const ipv6 = expandIPv6(host)
	if (ipv6) return { family: 6, groups: ipv6 }
	return null
}

function isBlockedAddress(host: string): boolean {
	const address = parseAddress(host)
	if (!address) return true // Not a literal where one was required — fail closed.
	return address.family === 4 ? isBlockedIPv4(address.groups) : isBlockedIPv6(address.groups)
}

function isBlockedHost(host: string): boolean {
	if (host === '') return true
	if (host === 'localhost' || host.endsWith('.localhost')) return true

	const address = parseAddress(host)
	if (address) return address.family === 4 ? isBlockedIPv4(address.groups) : isBlockedIPv6(address.groups)

	// A name. `assertFetchableTarget` resolves it and checks the addresses it maps to.
	return false
}

/** The port a request actually goes to; `URL.port` is empty for the scheme default. */
function effectivePort(url: URL): number {
	if (url.port !== '') return Number(url.port)
	return url.protocol === 'https:' ? 443 : 80
}

function isAllowlisted(url: URL, options: FetchGuardOptions | undefined): boolean {
	const host = normalizeHost(url.hostname)
	if (host === '') return false
	const port = effectivePort(url)

	for (const raw of options?.allowedHosts ?? []) {
		const entry: AllowedHostEntry | null = parseAllowedHostEntry(raw)
		if (!entry || entry.host !== host) continue
		if (entry.port === undefined || entry.port === port) return true
	}
	return false
}

async function defaultResolveHost(hostname: string): Promise<readonly string[]> {
	const records = await lookup(hostname, { all: true, verbatim: true })
	return records.map(record => record.address)
}

/** Accept a URL only when it is http(s) and its host literal is not one we refuse to reach. */
export function assertFetchableUrl(raw: string, options?: FetchGuardOptions): Result<URL, DomainError> {
	let url: URL
	try {
		url = new URL(raw)
	} catch {
		return Err(fetchError('Invalid URL'))
	}

	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return Err(fetchError('URL scheme must be http or https'))
	}

	if (isAllowlisted(url, options)) return Ok(url)
	if (isBlockedHost(normalizeHost(url.hostname))) return Err(fetchError('URL host is not allowed'))

	return Ok(url)
}

/**
 * `assertFetchableUrl` plus DNS: resolve a hostname and refuse every address it maps to.
 *
 * Without this, one attacker-controlled DNS record (`169.254.169.254.nip.io`)
 * walks past every literal test. Resolving here closes that; the residual gap is
 * DNS rebinding, where the record changes between this lookup and the one
 * `fetch` does — closing that needs socket-level pinning, which is out of scope.
 */
async function assertFetchableTarget(raw: string, options?: FetchGuardOptions): Promise<Result<URL, DomainError>> {
	const checked = assertFetchableUrl(raw, options)
	if (!checked.ok) return checked

	// An allowlisted host is the operator's explicit statement of trust — it exists to
	// name a host in a blocked range, so resolving it would only block it again.
	if (isAllowlisted(checked.value, options)) return checked

	const host = normalizeHost(checked.value.hostname)
	if (parseAddress(host)) return checked

	let addresses: readonly string[]
	try {
		addresses = await (options?.resolveHost ?? defaultResolveHost)(host)
	} catch {
		return Err(fetchError('URL host could not be resolved'))
	}
	if (addresses.length === 0) return Err(fetchError('URL host could not be resolved'))
	if (addresses.some(address => isBlockedAddress(normalizeHost(address)))) {
		return Err(fetchError('URL host is not allowed'))
	}

	return checked
}

/**
 * Fetch a caller-supplied URL, re-checking every redirect hop.
 *
 * `redirect: 'manual'` is the point: the platform's own redirect following would
 * land on a blocked host without ever handing us the intermediate URL.
 */
export async function safeFetch(
	raw: string,
	options: FetchGuardOptions & { timeoutMs: number },
): Promise<Result<Response, DomainError>> {
	let target = await assertFetchableTarget(raw, options)
	if (!target.ok) return target

	const signal = AbortSignal.timeout(options.timeoutMs)

	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		let response: Response
		try {
			response = await fetch(target.value, { redirect: 'manual', signal })
		} catch (err) {
			return Err(fetchError(`Failed to fetch URL: ${err instanceof Error ? err.message : String(err)}`))
		}

		if (response.status < 300 || response.status > 399) return Ok(response)

		const location = response.headers.get('Location')
		if (!location) return Err(fetchError(`URL returned ${response.status}`))

		try {
			await response.body?.cancel()
		} catch {
			// The hop's body is discarded either way.
		}

		let next: URL
		try {
			next = new URL(location, target.value)
		} catch {
			return Err(fetchError('Invalid redirect location'))
		}

		const checked = await assertFetchableTarget(next.href, options)
		if (!checked.ok) return checked
		target = checked
	}

	return Err(fetchError('Too many redirects'))
}

/**
 * Read a response body, giving up once it passes `maxBytes`. Null means over the cap.
 *
 * `Content-Length` is the sender's claim, and `arrayBuffer()` materialises the whole
 * body before anything can check it — so a chunked response that declares no length
 * is buffered in full before it is rejected. Streaming caps it at the real byte count.
 */
export async function readBodyWithLimit(response: Response, maxBytes: number): Promise<Buffer | null> {
	const reader = response.body?.getReader()
	if (!reader) return Buffer.alloc(0)

	const chunks: Uint8Array[] = []
	let total = 0
	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			total += value.byteLength
			if (total > maxBytes) {
				await reader.cancel()
				return null
			}
			chunks.push(value)
		}
	} finally {
		reader.releaseLock()
	}

	return Buffer.concat(chunks)
}
