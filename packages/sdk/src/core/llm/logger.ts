/**
 * LLM Request/Response Logger
 *
 * Logs LLM calls as individual JSON files for debugging and audit.
 * Per spec.md 9.1: "Pro debugging a audit se bude logovat kompletní LLM komunikace"
 *
 * Calls are stored in the session folder: {dataPath}/sessions/{sessionId}/calls/
 */

import { join } from 'node:path'
import type { AgentId } from '~/core/agents/schema.js'
import { generateLLMCallId, LLMCallId } from '~/core/llm/schema.js'
import type { SessionId } from '~/core/sessions/schema.js'
import type { FileSystem } from '~/platform/fs.js'
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
}

// ============================================================================
// LLMLogger
// ============================================================================

/**
 * Logger for LLM requests and responses.
 * Stores individual JSON files per LLM call in the session folder.
 */
export class LLMLogger {
	private dirCache = new Set<string>()
	private readonly fs: FileSystem

	constructor(private config: LLMLoggerConfig) {
		this.fs = config.fs
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
		const filePath = this.getCallFilePath(sessionId, callId)

		let entry: LLMCallLogEntry
		try {
			const content = await this.fs.readFile(filePath, 'utf-8')
			entry = JSON.parse(content) as LLMCallLogEntry
		} catch {
			// File doesn't exist or is invalid - skip update
			return
		}

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
		const filePath = this.getCallFilePath(sessionId, callId)

		let entry: LLMCallLogEntry
		try {
			const content = await this.fs.readFile(filePath, 'utf-8')
			entry = JSON.parse(content) as LLMCallLogEntry
		} catch {
			// File doesn't exist or is invalid - skip update
			return
		}

		const callError: LLMCallError = {
			type: error.type,
			message: error.message,
			retryAfterMs: error.retryAfterMs,
			statusCode: error.statusCode,
			responseBody: error.responseBody,
		}

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
		const filePath = this.getCallFilePath(sessionId, callId)

		try {
			const content = await this.fs.readFile(filePath, 'utf-8')
			return JSON.parse(content) as LLMCallLogEntry
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
		const offset = options?.offset ?? 0
		const limit = options?.limit ?? 100
		const paginated = jsonFiles.slice(offset, offset + limit)

		const calls: LLMCallLogEntry[] = []
		for (const file of paginated) {
			try {
				const filePath = join(callsDir, file)
				const content = await this.fs.readFile(filePath, 'utf-8')
				calls.push(JSON.parse(content) as LLMCallLogEntry)
			} catch {
				// Skip invalid files
			}
		}

		return { calls, total }
	}
}
