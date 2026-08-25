/**
 * Fetch Guard Tests
 *
 * `upload-from-url` and `inject-resource` hand this module a caller-supplied
 * URL, so the interesting cases are the ones a URL parser normalises for us
 * (`0177.0.0.1`, `2130706433`, `[0:0:0:0:0:0:0:1]`) and the redirect hop.
 */
import { describe, expect, it } from 'bun:test'
import { assertFetchableUrl, readBodyWithLimit, safeFetch } from './fetch-guard.js'

describe('assertFetchableUrl', () => {
	it('accepts a public http(s) URL', () => {
		for (const raw of ['https://example.com/file.zip', 'http://example.com:8080/file.zip', 'https://8.8.8.8/x']) {
			expect(assertFetchableUrl(raw).ok).toBe(true)
		}
	})

	it('rejects a non-http scheme', () => {
		for (const raw of ['file:///etc/passwd', 'ftp://example.com/x', 'data:text/plain,hi']) {
			const result = assertFetchableUrl(raw)
			expect(result.ok).toBe(false)
			expect(!result.ok && result.error.httpStatus).toBe(400)
		}
	})

	it('rejects something that is not a URL', () => {
		expect(assertFetchableUrl('').ok).toBe(false)
		expect(assertFetchableUrl('/relative/path').ok).toBe(false)
	})

	it('rejects loopback, private and link-local hosts', () => {
		const blocked = [
			'http://localhost/x',
			'http://app.localhost/x',
			'http://127.0.0.1/x',
			'http://127.1.2.3/x',
			'http://0.0.0.0/x',
			'http://10.1.2.3/x',
			'http://172.16.0.1/x',
			'http://172.31.255.255/x',
			'http://192.168.1.1/x',
			'http://169.254.169.254/latest/meta-data',
			'http://[::1]/x',
			'http://[::]/x',
			'http://[fd00::1]/x',
			'http://[fe80::1]/x',
		]
		for (const raw of blocked) {
			expect(assertFetchableUrl(raw).ok).toBe(false)
		}
	})

	it('rejects the encodings a URL parser normalises into a blocked address', () => {
		const blocked = [
			'http://0177.0.0.1/x', // octal
			'http://2130706433/x', // integer
			'http://[0:0:0:0:0:0:0:1]/x', // uncompressed ::1
			'http://[::ffff:127.0.0.1]/x', // IPv4-mapped
			'http://user:pass@127.0.0.1/x', // userinfo
			'http://LOCALHOST./x', // case + root dot
		]
		for (const raw of blocked) {
			expect(assertFetchableUrl(raw).ok).toBe(false)
		}
	})

	it('rejects the ranges that carry infrastructure endpoints', () => {
		const blocked = [
			'http://100.64.0.1/x', // 100.64.0.0/10 CGNAT
			'http://100.100.100.200/latest/meta-data', // a cloud metadata endpoint lives here
			'http://192.0.0.1/x', // 192.0.0.0/24 IETF protocol assignments
			'http://198.18.0.1/x', // 198.18.0.0/15 benchmarking
			'http://198.19.255.255/x',
			'http://224.0.0.1/x', // 224.0.0.0/4 multicast
			'http://240.0.0.1/x', // 240.0.0.0/4 reserved
			'http://255.255.255.255/x', // broadcast
		]
		for (const raw of blocked) {
			expect(assertFetchableUrl(raw).ok).toBe(false)
		}
	})

	it('keeps the neighbours of those ranges reachable', () => {
		const allowed = [
			'http://100.63.0.1/x',
			'http://100.128.0.1/x',
			'http://192.0.1.1/x',
			'http://198.17.0.1/x',
			'http://198.20.0.1/x',
			'http://223.255.255.255/x',
		]
		for (const raw of allowed) {
			expect(assertFetchableUrl(raw).ok).toBe(true)
		}
	})

	it('strips every trailing root dot before matching', () => {
		for (const raw of ['http://localhost../x', 'http://localhost.../x', 'http://app.localhost../x']) {
			expect(assertFetchableUrl(raw).ok).toBe(false)
		}
	})

	it('rejects the IPv6 forms that embed a blocked IPv4 destination', () => {
		const blocked = [
			'http://[::127.0.0.1]/x', // IPv4-compatible
			'http://[::ffff:0:127.0.0.1]/x', // IPv4-translated
			'http://[64:ff9b::7f00:1]/x', // NAT64 well-known prefix
			'http://[2002:7f00:1::]/x', // 6to4
			'http://[ff02::1]/x', // multicast
		]
		for (const raw of blocked) {
			expect(assertFetchableUrl(raw).ok).toBe(false)
		}
	})

	it('keeps a global IPv6 address reachable', () => {
		expect(assertFetchableUrl('http://[2606:4700::6810:85e5]/x').ok).toBe(true)
		expect(assertFetchableUrl('http://[::ffff:8.8.8.8]/x').ok).toBe(true)
	})

	it('keeps neighbouring ranges reachable', () => {
		for (const raw of ['http://172.15.0.1/x', 'http://172.32.0.1/x', 'http://192.169.0.1/x', 'http://11.0.0.1/x']) {
			expect(assertFetchableUrl(raw).ok).toBe(true)
		}
	})

	it('honours the opt-in allowlist', () => {
		expect(assertFetchableUrl('http://127.0.0.1:9000/bucket').ok).toBe(false)

		const allowedHosts = ['example.internal', '127.0.0.1']

		expect(assertFetchableUrl('http://127.0.0.1:9000/bucket', { allowedHosts }).ok).toBe(true)
		expect(assertFetchableUrl('http://10.0.0.1/x', { allowedHosts }).ok).toBe(false)
	})

	it('matches an allowlist entry that pins a port', () => {
		const allowedHosts = ['127.0.0.1:9000']

		expect(assertFetchableUrl('http://127.0.0.1:9000/bucket', { allowedHosts }).ok).toBe(true)
		// Allowlisting the object store must not also open ssh on the same host.
		expect(assertFetchableUrl('http://127.0.0.1:22/x', { allowedHosts }).ok).toBe(false)
		expect(assertFetchableUrl('http://127.0.0.1/x', { allowedHosts }).ok).toBe(false)
	})

	it('matches a pinned port against the scheme default', () => {
		expect(assertFetchableUrl('http://10.0.0.1/x', { allowedHosts: ['10.0.0.1:80'] }).ok).toBe(true)
		expect(assertFetchableUrl('https://10.0.0.1/x', { allowedHosts: ['10.0.0.1:443'] }).ok).toBe(true)
		expect(assertFetchableUrl('https://10.0.0.1/x', { allowedHosts: ['10.0.0.1:80'] }).ok).toBe(false)
	})

	it('matches a bracketed IPv6 allowlist entry that pins a port', () => {
		expect(assertFetchableUrl('http://[::1]:9000/x', { allowedHosts: ['[::1]:9000'] }).ok).toBe(true)
		expect(assertFetchableUrl('http://[::1]:9001/x', { allowedHosts: ['[::1]:9000'] }).ok).toBe(false)
	})

	it('normalises allowlist entries the way it normalises the URL host', () => {
		// Config hands these through verbatim, so the guard owns case, padding and IPv6 brackets.
		expect(assertFetchableUrl('http://[::1]/x', { allowedHosts: [' [::1] '] }).ok).toBe(true)
		expect(assertFetchableUrl('http://APP.localhost/x', { allowedHosts: ['app.LOCALHOST'] }).ok).toBe(true)
	})

	it('fails closed when no allowlist is passed', () => {
		expect(assertFetchableUrl('http://127.0.0.1/x', {}).ok).toBe(false)
		expect(assertFetchableUrl('http://127.0.0.1/x', { allowedHosts: [] }).ok).toBe(false)
	})
})

describe('safeFetch', () => {
	it('refuses a blocked URL without issuing a request', async () => {
		const result = await safeFetch('http://169.254.169.254/latest/meta-data', { timeoutMs: 1_000 })

		expect(result.ok).toBe(false)
		expect(!result.ok && result.error.type).toBe('fetch_error')
	})

	it('blocks a name that resolves to a blocked address', async () => {
		// One DNS record (the `*.nip.io` trick) is all it takes to walk past every literal check.
		const result = await safeFetch('http://metadata.example.invalid/latest/meta-data', {
			timeoutMs: 1_000,
			resolveHost: async () => ['169.254.169.254'],
		})

		expect(result.ok).toBe(false)
		expect(!result.ok && result.error.message).toBe('URL host is not allowed')
	})

	it('blocks when any one of the resolved addresses is blocked', async () => {
		const result = await safeFetch('http://split.example.invalid/x', {
			timeoutMs: 1_000,
			resolveHost: async () => ['93.184.216.34', '::1'],
		})

		expect(result.ok).toBe(false)
		expect(!result.ok && result.error.message).toBe('URL host is not allowed')
	})

	it('fails closed when the host does not resolve', async () => {
		const resolvers: Array<(hostname: string) => Promise<readonly string[]>> = [
			async () => [],
			async () => {
				throw new Error('ENOTFOUND')
			},
		]

		for (const resolveHost of resolvers) {
			const result = await safeFetch('http://nowhere.example.invalid/x', { timeoutMs: 1_000, resolveHost })
			expect(result.ok).toBe(false)
			expect(!result.ok && result.error.message).toBe('URL host could not be resolved')
		}
	})

	it('resolves through the platform resolver when none is injected', async () => {
		// `.invalid` never resolves (RFC 2606), so reaching the resolver at all is what this asserts.
		const result = await safeFetch('http://nothing.example.invalid/x', { timeoutMs: 1_000 })

		expect(result.ok).toBe(false)
		expect(!result.ok && result.error.message).toBe('URL host could not be resolved')
	})

	it('re-checks the resolved address on a redirect hop', async () => {
		const server = Bun.serve({
			port: 0,
			fetch: () =>
				new Response(null, {
					status: 302,
					headers: { Location: 'http://metadata.example.invalid/latest/meta-data' },
				}),
		})

		try {
			const result = await safeFetch(`http://${server.hostname}:${server.port}/redirect`, {
				timeoutMs: 5_000,
				allowedHosts: [server.hostname ?? '127.0.0.1'],
				resolveHost: async () => ['169.254.169.254'],
			})

			expect(result.ok).toBe(false)
			expect(!result.ok && result.error.message).toBe('URL host is not allowed')
		} finally {
			await server.stop(true)
		}
	})

	it('skips resolution for an allowlisted host', async () => {
		const server = Bun.serve({ port: 0, fetch: () => new Response('ok') })

		try {
			const result = await safeFetch(`http://${server.hostname}:${server.port}/plain`, {
				timeoutMs: 5_000,
				allowedHosts: [`${server.hostname}:${server.port}`],
				// The allowlist is the operator's own statement of trust; resolving would only re-block it.
				resolveHost: async () => {
					throw new Error('resolver must not run for an allowlisted host')
				},
			})

			expect(result.ok).toBe(true)
			expect(result.ok && result.value.status).toBe(200)
		} finally {
			await server.stop(true)
		}
	})

	it('re-checks the host on every redirect hop', async () => {
		const server = Bun.serve({
			port: 0,
			fetch: (request) => {
				if (new URL(request.url).pathname === '/redirect') {
					return new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/latest/meta-data' } })
				}
				return new Response('ok')
			},
		})

		try {
			// The origin itself is loopback, so it takes the allowlist to reach hop one at all.
			const allowedHosts = [server.hostname ?? '127.0.0.1']

			const direct = await safeFetch(`http://${server.hostname}:${server.port}/plain`, { timeoutMs: 5_000, allowedHosts })
			expect(direct.ok).toBe(true)
			expect(direct.ok && direct.value.status).toBe(200)

			const redirected = await safeFetch(`http://${server.hostname}:${server.port}/redirect`, { timeoutMs: 5_000, allowedHosts })
			expect(redirected.ok).toBe(false)
			expect(!redirected.ok && redirected.error.message).toBe('URL host is not allowed')
		} finally {
			await server.stop(true)
		}
	})
})

describe('readBodyWithLimit', () => {
	function streamed(chunks: readonly string[]): Response {
		const encoder = new TextEncoder()
		return new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
					controller.close()
				},
			}),
		)
	}

	it('returns a body that stays under the cap', async () => {
		const body = await readBodyWithLimit(streamed(['abc', 'de']), 16)

		expect(body?.toString('utf-8')).toBe('abcde')
	})

	it('stops a chunked body with no Content-Length before it is fully materialised', async () => {
		let produced = 0
		const encoder = new TextEncoder()
		const response = new Response(
			new ReadableStream<Uint8Array>({
				pull(controller) {
					produced += 1
					controller.enqueue(encoder.encode('x'.repeat(1024)))
				},
			}),
		)

		expect(await readBodyWithLimit(response, 4096)).toBeNull()
		// The cap is enforced per chunk, so the endless stream never runs away.
		expect(produced).toBeLessThanOrEqual(6)
	})

	it('treats a body with no stream as empty', async () => {
		expect((await readBodyWithLimit(new Response(null), 16))?.length).toBe(0)
	})
})
