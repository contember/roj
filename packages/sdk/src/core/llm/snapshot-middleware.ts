/**
 * Snapshot-caching LLM middleware for e2e tests.
 *
 * Works at the InferenceRequest/InferenceResponse boundary (not HTTP). On a
 * request hit, returns the cached response without calling the downstream
 * provider. On a miss, forwards the request, records the response, writes
 * one snapshot file per request hash.
 *
 * Unlike the lower-level `snapshot-fetch` (which writes one file per testName
 * and overwrites on each call), this middleware keys by request hash — so a
 * single multi-turn test records N independent snapshots.
 *
 * Usage:
 *   startStandaloneServer({
 *     presets: [myPreset],
 *     llmMiddleware: [createSnapshotLLMMiddleware({ snapshotsDir: '...' })],
 *   })
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Err, Ok } from '~/lib/utils/result.js'
import type { LLMMiddleware } from './middleware.js'
import type { InferenceRequest, InferenceResponse } from './provider.js'

export interface SnapshotLLMMiddlewareOptions {
	/** Directory where per-request snapshot files are stored. */
	snapshotsDir: string
	/**
	 * - `auto` (default) — replay if snapshot exists, otherwise record.
	 * - `replay` — fail on miss. Use in CI to catch accidental live calls.
	 * - `record` — always call next and (over)write the snapshot.
	 */
	mode?: 'auto' | 'replay' | 'record'
	/**
	 * Transform the request before hashing. Returns a request used only for
	 * key computation — the original is still sent downstream on cache miss.
	 *
	 * Use this to strip run-local data (session IDs, timestamps, random
	 * workspace paths) that would otherwise prevent snapshots from matching
	 * across runs. See `stripUuids` for a common default.
	 */
	normalize?: (request: InferenceRequest) => InferenceRequest
}

/**
 * Replace all UUIDs in a string with a `__UUID__` placeholder.
 */
export function stripUuids(text: string): string {
	return text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '__UUID__')
}

/**
 * Replace dynamically assigned TCP ports (e.g. `port 46140`, `:46140`) with
 * a `__PORT__` placeholder. Dev services in roj pick free ports at runtime,
 * which otherwise bust the snapshot key on every run.
 */
export function stripEphemeralPorts(text: string): string {
	return text
		.replace(/port\s+(\d{4,5})\b/gi, 'port __PORT__')
		.replace(/:(1[0-9]{4}|[2-6][0-9]{4})\b/g, ':__PORT__')
}

/**
 * Compose multiple text stripping functions.
 */
export function composeStrippers(...fns: Array<(text: string) => string>): (text: string) => string {
	return (text) => fns.reduce((acc, fn) => fn(acc), text)
}

/**
 * Build a `normalize` hook that applies a text-level stripper to the system
 * prompt and all string-form message content / text parts.
 */
export function normalizeWith(stripper: (text: string) => string): (request: InferenceRequest) => InferenceRequest {
	return (request) => ({
		...request,
		systemPrompt: stripper(request.systemPrompt),
		messages: request.messages.map((m) => {
			if (typeof m.content === 'string') {
				return { ...m, content: stripper(m.content) }
			}
			if (Array.isArray(m.content)) {
				return {
					...m,
					content: m.content.map((part) =>
						part.type === 'text' ? { ...part, text: stripper(part.text) } : part,
					),
				}
			}
			return m
		}) as InferenceRequest['messages'],
	})
}

/**
 * A `normalize` implementation that strips UUIDs from the request text.
 * Use `normalizeStripRuntime` if dev service ports also leak into prompts.
 */
export const normalizeStripUuids = normalizeWith(stripUuids)

/**
 * `normalize` implementation for typical e2e runs: strips UUIDs and
 * dynamically-assigned ports. Covers the usual suspects; add your own with
 * `normalizeWith(composeStrippers(...))` for more.
 */
export const normalizeStripRuntime = normalizeWith(composeStrippers(stripUuids, stripEphemeralPorts))

interface SnapshotEntry {
	request: unknown
	response: InferenceResponse
}

function stableStringify(value: unknown): string {
	return JSON.stringify(value, (_key, val) => {
		if (val && typeof val === 'object' && !Array.isArray(val)) {
			return Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
		}
		return val
	})
}

/**
 * Build a stable digest of the request. Strips:
 *   - tool `input`/`execute` functions + Zod schemas (reduced to name/description)
 *   - conversation-metadata fields on messages (`timestamp`, `isError`,
 *     `toolName`, `sourceMessageIds`) — not forwarded to the LLM, so they
 *     shouldn't bust the snapshot key either.
 */
function stripMessageMetadata(message: unknown): unknown {
	if (!message || typeof message !== 'object') return message
	const { timestamp: _t, isError: _e, toolName: _n, sourceMessageIds: _s, ...rest } = message as Record<string, unknown>
	return rest
}

function buildDigest(request: InferenceRequest): Record<string, unknown> {
	return {
		model: String(request.model),
		systemPrompt: request.systemPrompt,
		messages: request.messages.map(stripMessageMetadata),
		tools: request.tools?.map((t) => ({ name: t.name, description: t.description })),
		maxTokens: request.maxTokens,
		temperature: request.temperature,
		stopSequences: request.stopSequences,
		openrouter: request.openrouter,
		anthropic: request.anthropic,
	}
}

function hashDigest(digest: unknown): string {
	return createHash('sha256').update(stableStringify(digest)).digest('hex').slice(0, 16)
}

export function createSnapshotLLMMiddleware(options: SnapshotLLMMiddlewareOptions): LLMMiddleware {
	const mode = options.mode ?? 'auto'
	mkdirSync(options.snapshotsDir, { recursive: true })

	return async (request, context, next) => {
		const forHashing = options.normalize ? options.normalize(request) : request
		const digest = buildDigest(forHashing)
		const hash = hashDigest(digest)
		const filePath = join(options.snapshotsDir, `${hash}.json`)
		const hasSnapshot = existsSync(filePath)

		if (mode !== 'record' && hasSnapshot) {
			const entry = JSON.parse(readFileSync(filePath, 'utf-8')) as SnapshotEntry
			return Ok(entry.response)
		}

		if (mode === 'replay') {
			return Err({
				type: 'invalid_request',
				message: `Snapshot not found (replay mode): ${hash}. Set mode to 'auto' or 'record' and provide API keys to record.`,
			})
		}

		const result = await next(request, context)
		if (result.ok) {
			const entry: SnapshotEntry = { request: digest, response: result.value }
			writeFileSync(filePath, JSON.stringify(entry, null, '\t'))
		}
		return result
	}
}
