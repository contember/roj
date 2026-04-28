/**
 * LLM Debug Plugin
 *
 * Provides session-level methods for querying LLM call logs:
 * - llm.getCalls — list LLM calls for a session
 * - llm.getCall — get single LLM call detail
 * - llm.getCurlCommand — export LLM call as curl command (with resolved images)
 */

import type { LLMMessage } from '~/core/agents/state.js'
import { ValidationErrors } from '~/core/errors.js'
import type { LLMCallLogEntry, LLMCallMessage } from '~/core/llm/llm-log-types.js'
import type { RawInferenceRequest, RawToolSpec } from '~/core/llm/provider.js'
import { LLMCallId } from '~/core/llm/schema.js'
import { ModelId } from '~/core/llm/schema.js'
import { definePlugin } from '~/core/plugins/index.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { Err, Ok } from '~/lib/utils/result.js'

import z4 from 'zod/v4'

// ============================================================================
// Helpers
// ============================================================================

/**
 * Convert stored LLMCallMessage[] back to LLMMessage[] for buildHttpRequest.
 */
function logMessagesToLLMMessages(messages: LLMCallMessage[]): LLMMessage[] {
	return messages.map((m): LLMMessage => {
		switch (m.role) {
			case 'user':
				return { role: 'user', content: m.content, cacheControl: m.cacheControl }
			case 'system':
				return {
					role: 'system',
					content: typeof m.content === 'string' ? m.content : '',
					cacheControl: m.cacheControl,
				}
			case 'assistant':
				return {
					role: 'assistant',
					content: typeof m.content === 'string' ? m.content : '',
					toolCalls: m.toolCalls?.map((tc) => ({
						id: ToolCallId(tc.id),
						name: tc.name,
						input: tc.input,
					})),
					cacheControl: m.cacheControl,
				}
			case 'tool':
				return {
					role: 'tool',
					content: m.content,
					toolCallId: ToolCallId(m.toolCallId ?? ''),
					cacheControl: m.cacheControl,
				}
		}
	})
}

/**
 * Format a ProviderHttpRequest as a curl command string.
 */
function formatCurl(httpRequest: { url: string; method: string; headers: Record<string, string>; body: unknown }): string {
	const parts = [`curl -X ${httpRequest.method}`]
	parts.push(`  '${httpRequest.url}'`)

	for (const [key, value] of Object.entries(httpRequest.headers)) {
		parts.push(`  -H '${key}: ${value}'`)
	}
	// Placeholder for auth header
	parts.push(`  -H 'Authorization: Bearer YOUR_API_KEY'`)

	parts.push(`  -d '${JSON.stringify(httpRequest.body)}'`)

	return parts.join(' \\\n')
}

// ============================================================================
// LLM Debug Plugin
// ============================================================================

export const llmDebugPlugin = definePlugin('llm')
	.method('getCalls', {
		input: z4.object({
			limit: z4.number().int().optional(),
			offset: z4.number().int().optional(),
		}),
		output: z4.object({
			calls: z4.array(z4.unknown()),
			total: z4.number(),
		}),
		handler: async (ctx, input) => {
			if (!ctx.llmLogger) {
				return Ok({ calls: [], total: 0 })
			}

			return Ok(
				await ctx.llmLogger.listCalls(ctx.sessionId, {
					limit: input.limit ?? 100,
					offset: input.offset ?? 0,
				}),
			)
		},
	})
	.method('getCall', {
		input: z4.object({
			callId: z4.string(),
		}),
		output: z4.unknown(),
		handler: async (ctx, input) => {
			const callId = LLMCallId(input.callId)

			if (!ctx.llmLogger) {
				return Err(ValidationErrors.invalid('LLM logging is not enabled'))
			}

			const call = await ctx.llmLogger.getCall(ctx.sessionId, callId)
			if (!call) {
				return Err(ValidationErrors.invalid(`LLM call not found: ${input.callId}`))
			}

			return Ok(call)
		},
	})
	.method('getCurlCommand', {
		input: z4.object({
			callId: z4.string(),
		}),
		output: z4.object({
			curl: z4.string(),
		}),
		handler: async (ctx, input) => {
			const callId = LLMCallId(input.callId)

			if (!ctx.llmLogger) {
				return Err(ValidationErrors.invalid('LLM logging is not enabled'))
			}

			const call = await ctx.llmLogger.getCall(ctx.sessionId, callId)
			if (!call) {
				return Err(ValidationErrors.invalid(`LLM call not found: ${input.callId}`))
			}

			if (!ctx.llm.buildHttpRequest) {
				return Err(ValidationErrors.invalid('LLM provider does not support HTTP request building'))
			}

			const rawRequest: RawInferenceRequest = {
				model: ModelId(call.request.model),
				systemPrompt: call.request.systemPrompt,
				messages: logMessagesToLLMMessages(call.request.messages),
				tools: call.request.tools?.map((t): RawToolSpec => ({
					name: t.name,
					description: t.description,
					parameters: t.parameters ?? {},
				})),
				maxTokens: call.request.maxTokens,
				temperature: call.request.temperature,
			}

			const httpRequest = await ctx.llm.buildHttpRequest(rawRequest, {
				sessionId: ctx.sessionId,
				agentId: call.agentId,
				fileStore: ctx.files,
			})

			return Ok({ curl: formatCurl(httpRequest) })
		},
	})
	.build()
