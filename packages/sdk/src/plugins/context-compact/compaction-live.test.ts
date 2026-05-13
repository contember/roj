/**
 * Live compaction tests against the real Anthropic API.
 *
 * Opt-in: run with `LIVE_TESTS=1 ANTHROPIC_API_KEY=…`. Skipped otherwise so the
 * default `bun test` run stays hermetic.
 *
 * These cover the two real-API claims of the context-compact rewrite (5c27ab7):
 *  1. The auxiliary-inference call (used by `ContextCompactor`) reuses the
 *     agent's warm prompt cache — only the trailing instruction + output are
 *     paid for, not the whole conversation a second time.
 *  2. `DEFAULT_SUMMARY_INSTRUCTION` actually elicits a plain-text summary from
 *     a real Sonnet/Haiku-class model (no tool calls, non-empty content), so
 *     the end-to-end `ContextCompactor.compact()` path produces a usable
 *     `[CONVERSATION SUMMARY]` block.
 */

import { describe, expect, test } from 'bun:test'
import { generateTestAgentId } from '~/core/agents/schema.js'
import type { ImageProcessor } from '~/core/image/types.js'
import type { LLMMessage } from '~/core/agents/state.js'
import { AnthropicProvider } from '~/core/llm/anthropic.js'
import { applyCacheBreakpoint } from '~/core/llm/cache-breakpoints.js'
import type { InferenceResponse, LLMError } from '~/core/llm/provider.js'
import { ModelId } from '~/core/llm/schema.js'
import { generateSessionId } from '~/core/sessions/schema.js'
import { silentLogger } from '~/lib/logger/logger.js'
import type { Result } from '~/lib/utils/result.js'
import {
	ContextCompactor,
	DEFAULT_SUMMARY_INSTRUCTION,
	type RunInferenceFn,
} from './context-compactor.js'

const liveEnabled = process.env.LIVE_TESTS === '1'
const anthropicApiKey = liveEnabled ? process.env.ANTHROPIC_API_KEY : undefined

const describeLive = (name: string, apiKey: string | undefined, fn: () => void) => {
	if (!apiKey) {
		describe.skip(`${name} (skipped — API key missing)`, fn)
		return
	}
	describe(name, fn)
}

const noopImageProcessor: ImageProcessor = {
	resolveContent: async (content) => content,
}

const MODEL = ModelId('claude-haiku-4-5-20251001')

/**
 * Padded system prompt so the cacheable prefix comfortably exceeds Anthropic's
 * 1024-token minimum for Haiku. Deterministic content so identical calls reuse
 * the exact same prefix.
 */
const LARGE_SYSTEM_PROMPT = [
	'You are a meticulous assistant helping a developer review a long conversation.',
	'Always respond concisely and accurately. Never speculate beyond the data.',
	'Follow these rules strictly:',
	...Array.from(
		{ length: 120 },
		(_, i) => `- Rule ${i + 1}: When asked about topic ${i + 1}, prefer factual sources and decline to speculate.`,
	),
	'End of instructions.',
].join('\n')

/**
 * Deterministic multi-turn history padded well past 1024 tokens so cache writes
 * and reads are unambiguous. Includes both user and assistant messages, which
 * is the shape an inline-compaction call sees in practice.
 */
function buildLongHistory(): LLMMessage[] {
	const history: LLMMessage[] = []
	for (let i = 0; i < 8; i++) {
		history.push({
			role: 'user',
			content:
				`Turn ${i + 1} user: please analyze topic ${i + 1}. `
				+ 'context detail '.repeat(30),
		})
		history.push({
			role: 'assistant',
			content:
				`Turn ${i + 1} assistant: here is my analysis of topic ${i + 1}. `
				+ 'analysis detail '.repeat(30),
		})
	}
	return history
}

describeLive('context-compact live: auxiliary inference cache reuse', anthropicApiKey, () => {
	test('priming inference then auxiliary summary call hits the prompt cache', async () => {
		const provider = new AnthropicProvider({
			apiKey: anthropicApiKey!,
			imageProcessor: noopImageProcessor,
			defaultModel: 'claude-haiku-4-5-20251001',
		})

		const history = buildLongHistory()

		// Call 1: regular inference, breakpoint on the last history message.
		// Mirrors what an Agent.advance() turn does just before requesting a
		// compaction summary.
		const primeMessages = applyCacheBreakpoint(history, 0, '1h')
		const prime = await provider.inference({
			model: MODEL,
			systemPrompt: LARGE_SYSTEM_PROMPT,
			messages: primeMessages,
		})
		if (!prime.ok) {
			if (prime.error.message?.includes('credit balance')) {
				console.warn('⚠️  Live compaction cache test skipped: credit balance too low')
				return
			}
			throw new Error(`prime call failed: ${JSON.stringify(prime.error)}`)
		}
		expect(prime.value.metrics.promptTokens).toBeGreaterThan(1024)

		// Call 2: simulate Agent.runAuxiliaryInference — append the summary
		// instruction as a trailing user message and place the breakpoint at
		// the same position as the prime call (last history message), so the
		// whole prefix lands as a cache read.
		const summaryInstruction: LLMMessage = { role: 'user', content: DEFAULT_SUMMARY_INSTRUCTION }
		const auxMessages = applyCacheBreakpoint([...history, summaryInstruction], 1, '1h')
		const aux = await provider.inference({
			model: MODEL,
			systemPrompt: LARGE_SYSTEM_PROMPT,
			messages: auxMessages,
		})
		if (!aux.ok) throw new Error(`auxiliary call failed: ${JSON.stringify(aux.error)}`)

		// Core claim: the auxiliary call served the prefix from cache (otherwise
		// we'd re-upload the entire conversation just to get a summary).
		expect(aux.value.metrics.cachedTokens ?? 0).toBeGreaterThan(1024)

		// Sonnet/Haiku reliably emit plain text under DEFAULT_SUMMARY_INSTRUCTION.
		// If this regresses, the prompt is no longer fit for purpose.
		expect(aux.value.toolCalls).toHaveLength(0)
		expect(aux.value.finishReason).toBe('stop')
		expect(aux.value.content ?? '').not.toBe('')
	}, 60_000)
})

describeLive('context-compact live: end-to-end compactor', anthropicApiKey, () => {
	test('ContextCompactor.compact() produces a real summary from a real model', async () => {
		const provider = new AnthropicProvider({
			apiKey: anthropicApiKey!,
			imageProcessor: noopImageProcessor,
			defaultModel: 'claude-haiku-4-5-20251001',
		})

		const history = buildLongHistory()

		// Wraps the provider exactly the way AgentContext.runAuxiliaryInference
		// does: full prefix + extraMessages, breakpoint pinned to the last
		// pre-extraMessages position so the agent's cache is reused.
		const auxCalls: InferenceResponse[] = []
		const runInference: RunInferenceFn = async (
			extraMessages,
		): Promise<Result<InferenceResponse, LLMError>> => {
			const messages = applyCacheBreakpoint(
				[...history, ...extraMessages],
				extraMessages.length,
				'1h',
			)
			const result = await provider.inference({
				model: MODEL,
				systemPrompt: LARGE_SYSTEM_PROMPT,
				messages,
			})
			if (result.ok) auxCalls.push(result.value)
			return result
		}

		// Prime the cache with one regular inference first, otherwise the
		// auxiliary call would pay full write cost — same as a real session
		// where compaction always runs after at least one normal turn.
		const prime = await provider.inference({
			model: MODEL,
			systemPrompt: LARGE_SYSTEM_PROMPT,
			messages: applyCacheBreakpoint(history, 0, '1h'),
		})
		if (!prime.ok) {
			if (prime.error.message?.includes('credit balance')) {
				console.warn('⚠️  Live compaction end-to-end test skipped: credit balance too low')
				return
			}
			throw new Error(`prime call failed: ${JSON.stringify(prime.error)}`)
		}

		const compactor = new ContextCompactor(silentLogger, {
			// Force compaction regardless of estimator vs actual tokens.
			maxTokens: 10,
			keepRecentMessages: 2,
		})

		const result = await compactor.compact(
			generateSessionId(),
			generateTestAgentId(),
			history,
			runInference,
		)

		expect(result.ok).toBe(true)
		if (!result.ok) return

		expect(result.value.messagesRemoved).toBeGreaterThan(0)
		expect(result.value.summary.trim().length).toBeGreaterThan(0)
		// keepRecentMessages=2 → summary message + 2 kept = 3 total
		expect(result.value.compactedMessages).toHaveLength(3)
		expect(result.value.compactedMessages[0].role).toBe('user')
		expect(result.value.compactedMessages[0].content as string).toContain(
			'[CONVERSATION SUMMARY]',
		)

		// The auxiliary inference under the compactor should have served the
		// prefix from cache (priming call wrote it).
		expect(auxCalls).toHaveLength(1)
		expect(auxCalls[0].metrics.cachedTokens ?? 0).toBeGreaterThan(1024)
	}, 60_000)
})
