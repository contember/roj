/**
 * LLM Request/Response Logger
 *
 * Logs LLM calls as individual JSON files for debugging and audit.
 * Per spec.md 9.1: "Pro debugging a audit se bude logovat kompletní LLM komunikace"
 *
 * Calls are stored in the session folder: {dataPath}/sessions/{sessionId}/calls/
 *
 * A host that has a table for them ({@link LLMCallStore}) gets rows instead: the
 * same entries, but `completeCall` stops reading the whole entry back to rewrite
 * it and `listCalls` stops being a `readdir` plus one read per row of the page.
 * Without a store nothing changes — same directory, same files, same content.
 */

import { join } from 'node:path'
import { AgentId } from '~/core/agents/schema.js'
import { generateLLMCallId, LLMCallId } from '~/core/llm/schema.js'
import type { SessionId } from '~/core/sessions/schema.js'
import { readTextFilesOrUndefined } from '~/lib/utils/fs-batch.js'
import type { FileSystem } from '~/platform/fs.js'
import type { LLMCallRow, LLMCallStore } from '~/platform/llm-call-log.js'
import type { LLMCallError, LLMCallLogEntry, LLMCallMessage, LLMCallMetrics, LLMCallRequest, LLMCallResponse } from './llm-log-types.js'
import type { InferenceRequest, InferenceResponse, LLMError } from './provider.js'

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for LLM logger
 */
export interface LLMLoggerConfig {
	/** Base data path (same as event store dataPath) */
	basePath: string
	enabled: boolean
	fs: FileSystem
	/** Rows instead of files, where the host has a table for them. */
	store?: LLMCallStore
}

const ENCODER = new TextEncoder()

/** UTF-8 length; the SDK cannot assume `Buffer`. */
function byteLength(text: string): number {
	return ENCODER.encode(text).byteLength
}

/**
 * Fit a request inside the host's column ceiling.
 *
 * Everything in a request is bounded by the agent definition except the message
 * history, which grows with the session and carries whole tool results. Over the
 * ceiling the store would reject the row and, because `createCall` is awaited on
 * the inference path, turn a logged call into a failed one.
 */
function clampRequest(request: LLMCallRequest, maxBytes: number | undefined): string {
	const json = JSON.stringify(request)
	// UTF-8 is at most 3 bytes per UTF-16 unit, so the common case never encodes.
	if (maxBytes === undefined || json.length * 3 <= maxBytes) return json

	const bytes = byteLength(json)
	if (bytes <= maxBytes) return json

	const dropped: LLMCallRequest = {
		...request,
		messages: [{
			role: 'system',
			content: `[${request.messages.length} messages, ${bytes} B, dropped: over the host's ${maxBytes} B column limit]`,
		}],
		tools: undefined,
	}
	const withoutMessages = JSON.stringify(dropped)
	if (byteLength(withoutMessages) <= maxBytes) return withoutMessages

	// A system prompt alone past the ceiling is pathological; keep only what a listing shows.
	const minimal: LLMCallRequest = {
		model: request.model,
		systemPrompt: `[${byteLength(request.systemPrompt)} B, dropped]`,
		messages: [],
		toolsCount: request.tools?.length ?? 0,
	}
	return JSON.stringify(minimal)
}

/** JSON this logger wrote itself; annotated rather than cast, and never validated on read. */
function parseJson<T>(json: string): T {
	return JSON.parse(json)
}

function parseOptionalJson<T>(json: string | undefined): T | undefined {
	return json === undefined ? undefined : parseJson<T>(json)
}

/** One stored entry, or null when the file stopped being JSON. */
function parseEntry(content: string): LLMCallLogEntry | null {
	try {
		return parseJson<LLMCallLogEntry>(content)
	} catch {
		return null
	}
}

// ============================================================================
// LLMLogger
// ============================================================================

/**
 * Logger for LLM requests and responses.
 * One JSON file per call in the session folder, or one row per call in a
 * {@link LLMCallStore} where the host has one.
 */
export class LLMLogger {
	private dirCache = new Set<string>()
	private readonly fs: FileSystem
	private readonly store?: LLMCallStore

	constructor(private config: LLMLoggerConfig) {
		this.fs = config.fs
		this.store = config.store
	}

	/**
	 * Check if logging is enabled.
	 */
	isEnabled(): boolean {
		return this.config.enabled
	}

	// ============================================================================
	// Individual LLM Call File Methods
	// ============================================================================

	/**
	 * Ensure the calls directory exists for a session.
	 * Calls are stored in {basePath}/sessions/{sessionId}/calls/
	 */
	private async ensureCallsDir(sessionId: SessionId): Promise<string> {
		const callsDir = join(this.config.basePath, 'sessions', sessionId, 'calls')
		if (!this.dirCache.has(callsDir)) {
			await this.fs.mkdir(callsDir, { recursive: true })
			this.dirCache.add(callsDir)
		}
		return callsDir
	}

	/**
	 * Get the path to an individual call file.
	 */
	private getCallFilePath(sessionId: SessionId, callId: LLMCallId): string {
		return join(this.config.basePath, 'sessions', sessionId, 'calls', `${callId}.json`)
	}

	/**
	 * Create a new LLM call entry when a request starts.
	 * Returns the generated call ID.
	 */
	async createCall(
		sessionId: SessionId,
		agentId: AgentId,
		request: InferenceRequest,
	): Promise<LLMCallId> {
		const callId = generateLLMCallId()
		const now = Date.now()

		const logMessages: LLMCallMessage[] = request.messages.map((m) => {
			// Use discriminated union to access role-specific fields
			switch (m.role) {
				case 'user':
					return { role: m.role, content: m.content, cacheControl: m.cacheControl }
				case 'system':
					return { role: m.role, content: m.content, cacheControl: m.cacheControl }
				case 'assistant':
					return {
						role: m.role,
						content: m.content,
						toolCalls: m.toolCalls?.map((tc) => ({
							id: tc.id,
							name: tc.name,
							input: tc.input,
						})),
						cacheControl: m.cacheControl,
					}
				case 'tool':
					return {
						role: m.role,
						content: m.content,
						toolCallId: m.toolCallId,
						cacheControl: m.cacheControl,
					}
			}
		})

		const providerOptions: LLMCallRequest['providerOptions'] = request.openrouter || request.anthropic
			? {
				...(request.openrouter ? { openrouter: request.openrouter } : {}),
				...(request.anthropic ? { anthropic: request.anthropic } : {}),
			}
			: undefined

		const callRequest: LLMCallRequest = {
			model: request.model,
			systemPrompt: request.systemPrompt,
			messages: logMessages,
			tools: request.tools?.map((t) => ({
				name: t.name,
				description: t.description,
				parameters: t.input.toJSONSchema(),
			})),
			toolsCount: request.tools?.length ?? 0,
			maxTokens: request.maxTokens,
			temperature: request.temperature,
			providerOptions,
		}

		if (this.store !== undefined) {
			await this.store.create(sessionId, {
				callId,
				agentId,
				createdAt: now,
				status: 'running',
				model: request.model,
				request: clampRequest(callRequest, this.store.maxBlobBytes),
			})
			return callId
		}

		const entry: LLMCallLogEntry = {
			id: callId,
			sessionId,
			agentId,
			createdAt: now,
			status: 'running',
			request: callRequest,
		}

		await this.ensureCallsDir(sessionId)
		const filePath = this.getCallFilePath(sessionId, callId)
		await this.fs.writeFile(filePath, JSON.stringify(entry, null, 2))

		return callId
	}

	/**
	 * Update a call entry with a successful response.
	 */
	async completeCall(
		sessionId: SessionId,
		callId: LLMCallId,
		response: InferenceResponse,
		durationMs: number,
	): Promise<void> {
		const callResponse: LLMCallResponse = {
			content: response.content,
			toolCalls: response.toolCalls.map((tc) => ({
				id: tc.id,
				name: tc.name,
				input: tc.input,
			})),
			finishReason: response.finishReason,
			reasoning: response.reasoning,
		}

		// Map metrics to extended format
		const callMetrics: LLMCallMetrics = {
			promptTokens: response.metrics.promptTokens,
			completionTokens: response.metrics.completionTokens,
			totalTokens: response.metrics.totalTokens,
			latencyMs: response.metrics.latencyMs,
			model: response.metrics.model,
			provider: response.metrics.provider,
			cost: response.metrics.cost,
			cachedTokens: response.metrics.cachedTokens,
			cacheWriteTokens: response.metrics.cacheWriteTokens,
			reasoningTokens: response.metrics.reasoningTokens,
		}

		if (this.store !== undefined) {
			// The whole reason for splitting the row: no read-back, and the request
			// column is not in the SET list.
			await this.store.complete(sessionId, callId, {
				status: 'success',
				completedAt: Date.now(),
				durationMs,
				providerRequestId: response.providerRequestId,
				response: JSON.stringify(callResponse),
				metrics: JSON.stringify(callMetrics),
			})
			return
		}

		const filePath = this.getCallFilePath(sessionId, callId)
		const entry = await this.readEntry(filePath)
		// File doesn't exist or is invalid - skip update
		if (entry === null) return

		entry.status = 'success'
		entry.completedAt = Date.now()
		entry.durationMs = durationMs
		entry.response = callResponse
		entry.metrics = callMetrics
		entry.providerRequestId = response.providerRequestId

		await this.fs.writeFile(filePath, JSON.stringify(entry, null, 2))
	}

	/**
	 * Update a call entry with an error.
	 */
	async failCall(
		sessionId: SessionId,
		callId: LLMCallId,
		error: LLMError,
		durationMs: number,
	): Promise<void> {
		const callError: LLMCallError = {
			type: error.type,
			message: error.message,
			retryAfterMs: error.retryAfterMs,
			statusCode: error.statusCode,
			responseBody: error.responseBody,
		}

		if (this.store !== undefined) {
			await this.store.complete(sessionId, callId, {
				status: 'error',
				completedAt: Date.now(),
				durationMs,
				error: JSON.stringify(callError),
			})
			return
		}

		const filePath = this.getCallFilePath(sessionId, callId)
		const entry = await this.readEntry(filePath)
		// File doesn't exist or is invalid - skip update
		if (entry === null) return

		entry.status = 'error'
		entry.completedAt = Date.now()
		entry.durationMs = durationMs
		entry.error = callError

		await this.fs.writeFile(filePath, JSON.stringify(entry, null, 2))
	}

	/**
	 * Get a single LLM call entry.
	 */
	async getCall(
		sessionId: SessionId,
		callId: LLMCallId,
	): Promise<LLMCallLogEntry | null> {
		if (this.store !== undefined) {
			const row = await this.store.get(sessionId, callId)
			return row === null ? null : toEntry(sessionId, row)
		}

		return this.readEntry(this.getCallFilePath(sessionId, callId))
	}

	/** One stored entry, or null when the file has gone or stopped being JSON. */
	private async readEntry(filePath: string): Promise<LLMCallLogEntry | null> {
		try {
			return parseEntry(await this.fs.readFile(filePath, 'utf-8'))
		} catch {
			return null
		}
	}

	/**
	 * List all LLM calls for a session.
	 */
	async listCalls(
		sessionId: SessionId,
		options?: { limit?: number; offset?: number },
	): Promise<{ calls: LLMCallLogEntry[]; total: number }> {
		const offset = options?.offset ?? 0
		const limit = options?.limit ?? 100

		if (this.store !== undefined) {
			// One indexed query where the file path listed a directory, sorted the
			// names and read the page's files one at a time. Same order, same page
			// boundaries — see LLMCallStore.list.
			const page = await this.store.list(sessionId, { limit, offset })
			return { calls: page.calls.map((row) => toEntry(sessionId, row)), total: page.total }
		}

		const callsDir = join(this.config.basePath, 'sessions', sessionId, 'calls')

		let files: string[]
		try {
			files = await this.fs.readdir(callsDir)
		} catch {
			// Directory doesn't exist
			return { calls: [], total: 0 }
		}

		// Filter to only JSON files and sort by name (UUIDv7 is sortable)
		const jsonFiles = files
			.filter((f) => f.endsWith('.json'))
			.sort()
			.reverse() // Most recent first

		const total = jsonFiles.length
		const paginated = jsonFiles.slice(offset, offset + limit)

		// The page is a known set of paths, so it is asked for as one where the
		// platform takes one — the same read the store branch above replaces with
		// a single query.
		const contents = await readTextFilesOrUndefined(this.fs, paginated.map((file) => join(callsDir, file)))

		const calls: LLMCallLogEntry[] = []
		for (const content of contents) {
			// Skip invalid files
			const entry = content === undefined ? null : parseEntry(content)
			if (entry !== null) calls.push(entry)
		}

		return { calls, total }
	}
}

/**
 * Reassemble a stored row into the entry every reader is typed against.
 *
 * `sessionId` comes from the key rather than the row: it is what the caller
 * looked the row up by, so storing it again would only be a second copy.
 */
function toEntry(sessionId: SessionId, row: LLMCallRow): LLMCallLogEntry {
	return {
		id: LLMCallId(row.callId),
		sessionId,
		agentId: AgentId(row.agentId),
		createdAt: row.createdAt,
		completedAt: row.completedAt,
		durationMs: row.durationMs,
		status: row.status,
		request: parseJson<LLMCallRequest>(row.request),
		response: parseOptionalJson<LLMCallResponse>(row.response),
		metrics: parseOptionalJson<LLMCallMetrics>(row.metrics),
		error: parseOptionalJson<LLMCallError>(row.error),
		providerRequestId: row.providerRequestId,
	}
}
