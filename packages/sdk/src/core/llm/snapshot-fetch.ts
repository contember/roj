/**
 * Snapshot-caching fetch wrapper for integration tests.
 *
 * On first run (or when request changes), makes a real HTTP call and saves
 * the request+response pair to a JSON snapshot file. On subsequent runs
 * with the same request, returns the cached response without making a call.
 *
 * Usage:
 *   const fetch = createSnapshotFetch(snapshotsDir)
 *   const provider = new AnthropicProvider({ ..., fetch })
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

interface SnapshotEntry {
	requestHash: string
	request: {
		url: string
		method: string
		headers: Record<string, string>
		body: unknown
	}
	response: {
		status: number
		headers: Record<string, string>
		body: unknown
	}
}

/**
 * Deterministic hash of a request (URL + method + body).
 * Headers are excluded because auth headers change between runs.
 */
function hashRequest(url: string, method: string, body: string): string {
	const hash = createHash('sha256')
	hash.update(method)
	hash.update(url)
	hash.update(stableStringify(JSON.parse(body)))
	return hash.digest('hex').slice(0, 16)
}

/**
 * JSON.stringify with sorted keys for deterministic output.
 */
function stableStringify(value: unknown): string {
	return JSON.stringify(value, (_key, val) => {
		if (val && typeof val === 'object' && !Array.isArray(val)) {
			return Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b)))
		}
		return val
	})
}

/**
 * Strip sensitive headers (auth) from a headers object for snapshot storage.
 */
function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
	const result: Record<string, string> = {}
	for (const [key, value] of Object.entries(headers)) {
		const lower = key.toLowerCase()
		if (lower === 'authorization' || lower === 'x-api-key') continue
		result[key] = value
	}
	return result
}

/**
 * Create a fetch function that caches request/response pairs as JSON snapshots.
 *
 * @param snapshotsDir - Directory to store snapshot files
 * @param testName - Test name used as the snapshot filename
 */
type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export function createSnapshotFetch(
	snapshotsDir: string,
	testName: string,
): FetchFn {
	const snapshotPath = join(snapshotsDir, `${testName}.json`)

	return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
		const method = init?.method ?? 'GET'
		const body = typeof init?.body === 'string' ? init.body : ''

		const currentHash = hashRequest(url, method, body)

		// Try loading existing snapshot
		let snapshot: SnapshotEntry | null = null
		try {
			const content = await readFile(snapshotPath, 'utf-8')
			snapshot = JSON.parse(content) as SnapshotEntry
		} catch {
			// No snapshot yet
		}

		// If snapshot exists and hash matches, return cached response
		if (snapshot && snapshot.requestHash === currentHash) {
			return new Response(JSON.stringify(snapshot.response.body), {
				status: snapshot.response.status,
				headers: snapshot.response.headers,
			})
		}

		// Make real request
		const response = await globalThis.fetch(input, init)
		const responseBody = await response.json()

		// Extract response headers
		const responseHeaders: Record<string, string> = {}
		response.headers.forEach((value, key) => {
			responseHeaders[key] = value
		})

		// Extract request headers
		const requestHeaders: Record<string, string> = {}
		if (init?.headers) {
			if (init.headers instanceof Headers) {
				init.headers.forEach((value, key) => {
					requestHeaders[key] = value
				})
			} else if (Array.isArray(init.headers)) {
				for (const [key, value] of init.headers) {
					requestHeaders[key] = value
				}
			} else {
				Object.assign(requestHeaders, init.headers)
			}
		}

		// Save snapshot
		const entry: SnapshotEntry = {
			requestHash: currentHash,
			request: {
				url,
				method,
				headers: sanitizeHeaders(requestHeaders),
				body: body ? JSON.parse(body) : null,
			},
			response: {
				status: response.status,
				headers: sanitizeHeaders(responseHeaders),
				body: responseBody,
			},
		}

		await mkdir(snapshotsDir, { recursive: true })
		await writeFile(snapshotPath, JSON.stringify(entry, null, '\t'))

		// Return a new Response from the parsed body (original was consumed)
		return new Response(JSON.stringify(responseBody), {
			status: response.status,
			headers: responseHeaders,
		})
	}
}
