/**
 * Live verification of the webmaster model shortlist against the real OpenRouter API.
 *
 * The list mirrors `AGENT_MODEL_OPTIONS` in webmaster `packages/api/feature-flags.ts` — the
 * models an org admin can pin an edit-session agent to. Every entry there had only ever been
 * read off a screenshot; this exercises each one through the SDK's real path:
 *
 *   SessionManager → Session → Agent → OpenRouterProvider → openrouter.ai
 *
 * so a pass means *our runtime* works with the model, not merely that the model exists. The
 * agent loop is forced through a tool call whose answer cannot be guessed (a made-up
 * identifier), then through `tell_user`, so the assertions cover: tool call with correct
 * arguments → tool result consumed → final user-visible answer containing the looked-up value.
 *
 * Every outbound HTTP body is recorded, which is what makes the secondary checks real rather
 * than assumed:
 *
 * - `cache_control` — `buildHttpRequest` attaches Anthropic-shaped markers unconditionally.
 *   Recorded per request, and on a 4xx the same body is replayed with the markers stripped to
 *   prove whether they were the cause.
 * - `reasoning_details` — the branch echoes them back on the next request. Proven by finding
 *   the key in a *later* outbound body, not by trusting the code path.
 * - `stop` — the agent always sends `['<message']`; several shortlist models do not list
 *   `stop` in `supported_parameters`.
 * - vision — separate one-shot requests with real PNG bytes, asserting the model names the
 *   colour rather than merely that the request shape was accepted.
 *
 * Opt-in, so a plain `bun test` stays hermetic and offline:
 *
 *   LIVE_TESTS=1 OPENROUTER_API_KEY=… bun test model-shortlist-live
 *
 * `LIVE_MODELS` (comma-separated slugs) narrows the run to a subset.
 */

import { describe, expect, test } from 'bun:test'
import z4 from 'zod/v4'
import { MemoryEventStore } from '~/core/events/memory.js'
import { SessionFileStore } from '~/core/file-store/file-store.js'
import type { ImageProcessor } from '~/core/image/types.js'
import { SessionManager } from '~/core/sessions/session-manager.js'
import { createTool } from '~/core/tools/definition.js'
import { ToolExecutor } from '~/core/tools/executor.js'
import { silentLogger } from '~/lib/logger/logger.js'
import { agentStatusPlugin } from '~/plugins/agent-status/plugin.js'
import { agentsPlugin } from '~/plugins/agents/plugin.js'
import { filesystemPlugin } from '~/plugins/filesystem/index.js'
import { gitStatusPlugin } from '~/plugins/git-status/index.js'
import { llmDebugPlugin } from '~/plugins/llm-debug/plugin.js'
import { logsPlugin } from '~/plugins/logs/index.js'
import { mailboxPlugin } from '~/plugins/mailbox/plugin.js'
import { resourcesPlugin } from '~/plugins/resources/plugin.js'
import { servicePlugin } from '~/plugins/services/plugin.js'
import { presetsPlugin, sessionLifecyclePlugin } from '~/plugins/session-lifecycle/index.js'
import { sessionStatePlugin } from '~/plugins/session-state/plugin.js'
import { sessionStatsPlugin } from '~/plugins/session-stats/index.js'
import { uploadsPlugin } from '~/plugins/uploads/plugin.js'
import { userChatPlugin } from '~/plugins/user-chat/plugin.js'
import { createNodePlatform } from '~/testing/node-platform.js'
import { createTestPreset } from '~/testing/preset-helpers.js'
import { waitForAllAgentsIdle } from '~/testing/wait-helpers.js'
import { OpenRouterProvider } from './openrouter.js'
import { ModelId } from './schema.js'

// ============================================================================
// Gating
// ============================================================================

const liveEnabled = process.env.LIVE_TESTS === '1'
const openRouterApiKey = liveEnabled ? process.env.OPENROUTER_API_KEY : undefined

/** Mirrors webmaster `AGENT_MODEL_OPTIONS`. Keep in sync by hand — the repos do not share code. */
const SHORTLIST = [
	'anthropic/claude-haiku-4.5',
	'anthropic/claude-sonnet-5',
	'anthropic/claude-sonnet-4.6',
	'anthropic/claude-opus-5',
	'openai/gpt-5.6-luna',
	'openai/gpt-5.6-terra',
	'openai/gpt-5.6-sol',
	'google/gemini-3.6-flash',
	'x-ai/grok-4.5',
	'moonshotai/kimi-k2.7-code',
	'moonshotai/kimi-k3',
]

const selectedModels = process.env.LIVE_MODELS ? process.env.LIVE_MODELS.split(',').map((s) => s.trim()).filter(Boolean) : SHORTLIST

/**
 * The constant from provider-integration.test.ts, where it is commented "1x1 red pixel". It is
 * actually a 1x1 RGBA pixel of #FFFF00 at alpha 127. Kept because xAI rejects it outright
 * (min 8x8), which is worth knowing before someone reuses it as a vision fixture.
 */
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='

/**
 * 32x32 opaque #0000FF — unambiguous to name, and above every provider's minimum. xAI is the
 * binding constraint: it rejects anything under 8px per side or under 512 total pixels, so 16x16
 * (256 px) is still too small.
 */
const BLUE_PNG_32 = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAJklEQVR42u3NsQkAAAjAsP7/tF7hIASyp5pjAoFAIBAIBAKB4EmwOkv8Lom8x/sAAAAASUVORK5CYII='

const noopImageProcessor: ImageProcessor = {
	resolveContent: async (content) => content,
}

// ============================================================================
// Recorded HTTP exchanges
// ============================================================================

interface RecordedContentItem {
	type: string
	text?: string
	cache_control?: { type: string; ttl?: string }
}

interface RecordedMessage {
	role: string
	content: string | RecordedContentItem[]
	tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>
	tool_call_id?: string
	reasoning_details?: unknown[]
}

interface RecordedRequestBody {
	model: string
	messages: RecordedMessage[]
	stop?: string[]
	max_tokens?: number
	temperature?: number
	tools?: Array<{ function: { name: string } }>
}

interface RecordedResponseBody {
	model?: string
	choices?: Array<{
		message?: { content?: string | null; reasoning_details?: unknown[]; tool_calls?: unknown[] }
		finish_reason?: string | null
	}>
	usage?: {
		prompt_tokens?: number
		completion_tokens?: number
		cost?: number
		prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }
		completion_tokens_details?: { reasoning_tokens?: number }
	}
	error?: { message?: string; code?: string | number; metadata?: unknown }
}

interface Exchange {
	request: RecordedRequestBody
	status: number
	rawResponse: string
	response?: RecordedResponseBody
}

/** Wraps real fetch and keeps the parsed request/response pair. Auth headers are never stored. */
const createRecordingFetch = (sink: Exchange[]) => {
	return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const requestBody: RecordedRequestBody = JSON.parse(typeof init?.body === 'string' ? init.body : '{}')
		const response = await globalThis.fetch(input, init)
		const rawResponse = await response.text()
		let parsed: RecordedResponseBody | undefined
		try {
			parsed = JSON.parse(rawResponse)
		} catch {
			parsed = undefined
		}
		sink.push({ request: requestBody, status: response.status, rawResponse, response: parsed })
		return new Response(rawResponse, { status: response.status, statusText: response.statusText, headers: response.headers })
	}
}

const hasCacheControl = (body: RecordedRequestBody): boolean =>
	body.messages.some((m) => Array.isArray(m.content) && m.content.some((c) => c.cache_control !== undefined))

/** Same body with every `cache_control` marker removed — the control for a 4xx. */
const stripCacheControl = (body: RecordedRequestBody): RecordedRequestBody => ({
	...body,
	messages: body.messages.map((m) => ({
		...m,
		content: Array.isArray(m.content) ? m.content.map(({ cache_control: _dropped, ...rest }) => rest) : m.content,
	})),
})

// ============================================================================
// The forced-tool-call scenario
// ============================================================================

/**
 * A made-up registry. No model can know that QX-88231 maps to ZK-7719, so a final answer
 * containing the code proves the tool was called AND its result was read.
 */
const GLORP_REGISTRY: Record<string, string> = { 'QX-88231': 'ZK-7719' }

const USER_PROMPT =
	'Look up the glorp code for artifact QX-88231 with the lookup_glorp_code tool, then tell me the code. Keep the reply under ten words.'

/** Padding so the cacheable prefix clears Anthropic\'s 1024-token minimum and a cache write can register. */
const SYSTEM_PADDING = Array.from(
	{ length: 90 },
	(_, i) => `- Rule ${i + 1}: never invent a glorp code; the registry tool is the only authority for artifact identifiers.`,
).join('\n')

const ORCHESTRATOR_SYSTEM = [
	'You are a terse registry assistant.',
	'You never guess identifiers. You look them up.',
	SYSTEM_PADDING,
].join('\n')

/** `PluginNotification.payload` is `unknown`; narrow it without widening anything. */
const readNotificationContent = (payload: unknown): string | undefined => {
	if (typeof payload !== 'object' || payload === null || !('content' in payload)) return undefined
	return typeof payload.content === 'string' ? payload.content : undefined
}

interface ModelOutcome {
	model: string
	/** Every argument object the tool was actually invoked with. */
	toolInvocations: unknown[]
	/** Answers routed through the `tell_user` system tool. Not every model uses it. */
	agentMessages: string[]
	/** Assistant text the agent committed to its own conversation history. */
	assistantTexts: string[]
	toolsOffered: string[]
	exchanges: Exchange[]
	idleTimedOut: boolean
}

const runAgentLoop = async (model: string): Promise<ModelOutcome> => {
	const exchanges: Exchange[] = []
	const toolInvocations: unknown[] = []
	const agentMessages: string[] = []

	const lookupTool = createTool({
		name: 'lookup_glorp_code',
		description: 'Look up the glorp code assigned to an artifact id in the internal registry.',
		input: z4.object({ artifactId: z4.string().describe('The artifact id, e.g. QX-88231') }),
		execute: async (input) => {
			toolInvocations.push(input)
			const code = GLORP_REGISTRY[input.artifactId]
			return { ok: true, value: code ? `glorp code: ${code}` : 'unknown artifact id' }
		},
	})

	const provider = new OpenRouterProvider({
		apiKey: openRouterApiKey ?? '',
		imageProcessor: noopImageProcessor,
		defaultModel: model,
		fetch: createRecordingFetch(exchanges),
	})

	const preset = createTestPreset({
		id: 'shortlist',
		orchestratorSystem: ORCHESTRATOR_SYSTEM,
	})
	preset.orchestrator.model = ModelId(model)
	preset.orchestrator.tools = [lookupTool]

	const basePath = `/tmp/roj-shortlist-${Math.random().toString(36).slice(2)}`
	const platform = createNodePlatform()
	const sessionManager = new SessionManager({
		eventStore: new MemoryEventStore(),
		llmProvider: provider,
		toolExecutor: new ToolExecutor(silentLogger),
		presets: new Map([[preset.id, preset]]),
		logger: silentLogger,
		basePath,
		dataFileStore: new SessionFileStore(basePath, undefined, false, platform.fs, 'session'),
		platform,
		onUserOutput: (notification) => {
			if (notification.pluginName !== 'user-chat' || notification.type !== 'agentMessage') return
			const content = readNotificationContent(notification.payload)
			if (content !== undefined) agentMessages.push(content)
		},
		systemPlugins: [
			sessionLifecyclePlugin,
			presetsPlugin,
			mailboxPlugin,
			agentsPlugin,
			agentStatusPlugin,
			userChatPlugin,
			uploadsPlugin,
			resourcesPlugin,
			llmDebugPlugin,
			servicePlugin,
			filesystemPlugin,
			logsPlugin,
			sessionStatsPlugin,
			sessionStatePlugin,
			gitStatusPlugin,
		],
	})

	const created = await sessionManager.createSession(preset.id)
	if (!created.ok) throw new Error(`createSession failed: ${created.error.type} — ${created.error.message}`)
	const session = created.value

	const entryAgentId = session.getEntryAgentId()
	if (!entryAgentId) throw new Error('no entry agent')

	const sent = await session.callPluginMethod('user-chat.sendMessage', {
		sessionId: String(session.id),
		content: USER_PROMPT,
		agentId: String(entryAgentId),
	})
	if (!sent.ok) throw new Error(`sendMessage failed: ${sent.error.type} — ${sent.error.message}`)

	let idleTimedOut = false
	try {
		await waitForAllAgentsIdle(session, { timeoutMs: 150_000 })
	} catch {
		// A non-retryable 4xx parks the agent in `error`, which never becomes idle. The recorded
		// exchanges are the evidence either way, so this is reported rather than thrown.
		idleTimedOut = true
	}

	const agentState = session.getAgent(entryAgentId)?.state
	const assistantTexts = (agentState?.conversationHistory ?? [])
		.filter((m) => m.role === 'assistant')
		.map((m) => (typeof m.content === 'string' ? m.content : ''))
		.filter((text) => text.length > 0)

	await sessionManager.shutdown()

	const toolsOffered = (exchanges[0]?.request.tools ?? []).map((t) => t.function.name)

	return { model, toolInvocations, agentMessages, assistantTexts, toolsOffered, exchanges, idleTimedOut }
}

// ============================================================================
// Reporting
// ============================================================================

/** Stable short identity for a reasoning_details array, for matching returned blocks to echoed ones. */
const reasoningFingerprint = (details: unknown[] | undefined): string | null => {
	if (!details?.length) return null
	const serialized = JSON.stringify(details)
	return `${details.length}b/${serialized.length}c/${serialized.slice(0, 24)}`
}

/** One machine-readable line per model, so the run can be turned into a matrix afterwards. */
const reportOutcome = (outcome: ModelOutcome): void => {
	const { exchanges } = outcome
	const failures = exchanges.filter((e) => e.status >= 400)
	const reasoningTurns = exchanges.filter((e) => (e.response?.choices?.[0]?.message?.reasoning_details?.length ?? 0) > 0).length
	const echoTurns = exchanges.filter((e) => e.request.messages.some((m) => m.role === 'assistant' && m.reasoning_details !== undefined)).length
	const assistantTurns = exchanges.flatMap((e) => e.request.messages.filter((m) => m.role === 'assistant')).length
	const cost = exchanges.reduce((sum, e) => sum + (e.response?.usage?.cost ?? 0), 0)
	const cached = exchanges.reduce((sum, e) => sum + (e.response?.usage?.prompt_tokens_details?.cached_tokens ?? 0), 0)
	const cacheWrites = exchanges.reduce((sum, e) => sum + (e.response?.usage?.prompt_tokens_details?.cache_write_tokens ?? 0), 0)

	console.log(
		`RESULT ${JSON.stringify({
			model: outcome.model,
			requests: exchanges.length,
			httpFailures: failures.map((f) => ({ status: f.status, body: f.rawResponse.slice(0, 400) })),
			cacheControlSent: exchanges.every((e) => hasCacheControl(e.request)),
			stopSent: exchanges[0]?.request.stop,
			promptTokens: exchanges.map((e) => e.response?.usage?.prompt_tokens ?? 0),
			cachedTokens: cached,
			cacheWriteTokens: cacheWrites,
			reasoningReturnedOnTurns: reasoningTurns,
			assistantMessagesSentBack: assistantTurns,
			assistantMessagesCarryingReasoningDetails: echoTurns,
			reasoningTrace: exchanges.map((e, i) => ({
				turn: i,
				returned: reasoningFingerprint(e.response?.choices?.[0]?.message?.reasoning_details),
				sentBack: e.request.messages.filter((m) => m.role === 'assistant').map((m) => reasoningFingerprint(m.reasoning_details)),
			})),
			toolInvocations: outcome.toolInvocations,
			tellUserOffered: outcome.toolsOffered.includes('tell_user'),
			usedTellUser: outcome.agentMessages.length > 0,
			agentMessages: outcome.agentMessages,
			assistantTexts: outcome.assistantTexts,
			idleTimedOut: outcome.idleTimedOut,
			cost,
		})}`,
	)
}

// ============================================================================
// Tests
// ============================================================================

const describeLive = (name: string, fn: () => void) => {
	if (!openRouterApiKey) {
		describe.skip(`${name} (skipped — LIVE_TESTS=1 + OPENROUTER_API_KEY required)`, fn)
		return
	}
	describe(name, fn)
}

describeLive('OpenRouter shortlist — agent loop', () => {
	for (const model of selectedModels) {
		test(`${model} runs a tool-calling agent turn`, async () => {
			const outcome = await runAgentLoop(model)
			reportOutcome(outcome)

			const failed = outcome.exchanges.filter((e) => e.status >= 400)
			if (failed.length > 0) {
				// Isolate the cause: replay the same body without the cache_control markers.
				const first = failed[0]
				const control = await globalThis.fetch('https://openrouter.ai/api/v1/chat/completions', {
					method: 'POST',
					headers: { 'content-type': 'application/json', 'Authorization': `Bearer ${openRouterApiKey}` },
					body: JSON.stringify(stripCacheControl(first.request)),
				})
				const controlBody = await control.text()
				console.log(`CONTROL ${JSON.stringify({ model, withoutCacheControl: control.status, body: controlBody.slice(0, 400) })}`)
			}

			expect(failed.map((f) => `${f.status} ${f.rawResponse.slice(0, 300)}`)).toEqual([])

			// The agent loop actually ran: correct tool, correct argument, result used in the answer.
			// The answer counts whether it came back as assistant text or through `tell_user` —
			// which one a model picks is instruction-following, not runtime compatibility.
			expect(outcome.toolInvocations).toContainEqual({ artifactId: 'QX-88231' })
			expect([...outcome.assistantTexts, ...outcome.agentMessages].join('\n')).toContain('ZK-7719')

			// cache_control travelled on every request — the point of the exercise.
			for (const exchange of outcome.exchanges) {
				expect(hasCacheControl(exchange.request)).toBe(true)
			}

			// The agent always sends stop sequences, whatever the model advertises.
			expect(outcome.exchanges[0].request.stop).toEqual(['<message'])

			// reasoning_details round trip. The negative control comes first: a model that never
			// reasons must produce no `reasoning_details` key anywhere on the wire, because the prompt
			// cache is keyed on the serialized prefix and the pre-fix bytes had no such key.
			const producedReasoning = outcome.exchanges.some((e) => (e.response?.choices?.[0]?.message?.reasoning_details?.length ?? 0) > 0)
			const echoed = outcome.exchanges.some((e) => e.request.messages.some((m) => m.role === 'assistant' && m.reasoning_details !== undefined))
			if (!producedReasoning) {
				expect(echoed).toBe(false)
				return
			}

			// Verbatim, on the wire: every block set that goes back out must be byte-identical to one
			// the provider returned earlier — nothing invented, reordered or edited, which is exactly
			// what OpenRouter rejects. All these requests came back 200 (asserted above), so the echo
			// was also accepted.
			//
			// The converse does not hold and must not be asserted: an auxiliary inference
			// (`runAuxiliaryInference`) and an empty-response retry both discard their response
			// without committing it to history, so some returned blocks legitimately never come back.
			const returnedFingerprints = new Set<string>()
			let verbatimEchoes = 0
			for (const exchange of outcome.exchanges) {
				for (const message of exchange.request.messages) {
					if (message.reasoning_details === undefined) continue
					expect(returnedFingerprints).toContain(JSON.stringify(message.reasoning_details))
					verbatimEchoes++
				}
				const returned = exchange.response?.choices?.[0]?.message?.reasoning_details
				if (returned?.length) returnedFingerprints.add(JSON.stringify(returned))
			}
			console.log(`ROUNDTRIP ${JSON.stringify({ model, verbatimEchoes, roundTripProven: verbatimEchoes > 0 })}`)
		}, 200_000)
	}
})

/**
 * `stop` is sent on every agent inference (`agent.ts` hardcodes `['<message']` to stop the model
 * hallucinating message tags), but several shortlist models do not list `stop` in
 * `supported_parameters`. OpenRouter drops unsupported parameters instead of erroring, so the
 * question is not "does the request fail" but "is the guard actually in force". Asking the model
 * to emit text that straddles the stop sequence answers it: truncated → honored, intact → dropped.
 */
describeLive('OpenRouter shortlist — stop sequences', () => {
	for (const model of selectedModels) {
		test(`${model} stop sequence behaviour`, async () => {
			const exchanges: Exchange[] = []
			const provider = new OpenRouterProvider({
				apiKey: openRouterApiKey ?? '',
				imageProcessor: noopImageProcessor,
				defaultModel: model,
				fetch: createRecordingFetch(exchanges),
			})

			const result = await provider.inference({
				model: ModelId(model),
				systemPrompt: 'You echo text literally. No preamble, no commentary, no markdown.',
				messages: [{ role: 'user', content: 'Repeat this line exactly, and nothing else: ALPHA<message>BRAVO' }],
				stopSequences: ['<message'],
				// Generous: a reasoning model spends most of its budget before the first visible token.
				maxTokens: 512,
			})

			const content = result.ok ? (result.value.content ?? '') : ''
			const reasoning = result.ok ? (result.value.reasoning ?? '') : ''

			// `honored_killed_turn` is the dangerous one: the sequence also applies to the reasoning
			// stream, so the model stops mid-thought and the turn yields no content at all.
			const verdict = content.includes('ALPHA') && !content.includes('BRAVO')
				? 'honored'
				: content.includes('ALPHA') && content.includes('BRAVO')
				? 'ignored'
				: content === '' && reasoning.includes('ALPHA') && !reasoning.includes('BRAVO')
				? 'honored_killed_turn'
				: 'inconclusive'

			console.log(
				`STOP ${JSON.stringify({
					model,
					status: exchanges[0]?.status,
					stopInRequest: exchanges[0]?.request.stop,
					verdict,
					content,
					reasoning: reasoning.slice(0, 200),
					finishReason: result.ok ? result.value.finishReason : undefined,
					error: result.ok ? undefined : result.error,
					cost: exchanges[0]?.response?.usage?.cost,
				})}`,
			)

			// The only hard requirement: sending `stop` must never break the request.
			expect(exchanges[0]?.request.stop).toEqual(['<message'])
			expect(exchanges[0]?.status).toBe(200)
		}, 120_000)
	}
})

interface VisionProbe {
	status: number | undefined
	content: string | null | undefined
	error: unknown
	body: string | undefined
	cost: number | undefined
}

const probeVision = async (model: string, imageBase64: string, maxTokens: number): Promise<VisionProbe> => {
	const exchanges: Exchange[] = []
	const provider = new OpenRouterProvider({
		apiKey: openRouterApiKey ?? '',
		imageProcessor: noopImageProcessor,
		defaultModel: model,
		fetch: createRecordingFetch(exchanges),
	})

	const result = await provider.inference({
		model: ModelId(model),
		systemPrompt: 'You describe images. Answer with a single colour word and nothing else.',
		messages: [{
			role: 'user',
			content: [
				{ type: 'text', text: 'What colour fills this image? Answer with one colour word.' },
				{ type: 'image_url', imageUrl: { url: `data:image/png;base64,${imageBase64}` } },
			],
		}],
		maxTokens,
	})

	return {
		status: exchanges[0]?.status,
		content: result.ok ? result.value.content : undefined,
		error: result.ok ? undefined : result.error,
		body: result.ok ? undefined : exchanges[0]?.rawResponse.slice(0, 300),
		cost: exchanges[0]?.response?.usage?.cost,
	}
}

describeLive('OpenRouter shortlist — vision', () => {
	for (const model of selectedModels) {
		test(`${model} accepts an inline image`, async () => {
			// Two fixtures: the existing 1x1 constant (some providers reject it on size), then a
			// 32x32 solid blue that clears every minimum. Answering "blue" is behavioural proof the
			// pixels arrived; a 200 with empty content only proves the request shape was accepted.
			const tiny = await probeVision(model, TINY_PNG, 64)
			const blue = await probeVision(model, BLUE_PNG_32, 512)

			console.log(`VISION ${JSON.stringify({ model, tiny1x1: tiny, blue32x32: blue, sawBlue: (blue.content ?? '').toLowerCase().includes('blue') })}`)

			expect(blue.status).toBe(200)
			expect((blue.content ?? '').toLowerCase()).toContain('blue')
		}, 180_000)
	}
})
