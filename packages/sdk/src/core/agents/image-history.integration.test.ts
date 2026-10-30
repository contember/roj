import { describe, expect, it } from 'bun:test'
import z from 'zod/v4'
import type { LLMMessage } from '~/core/agents/state.js'
import { DefaultImageProcessor } from '~/core/image/image-processor.js'
import { NoopImageResizer } from '~/core/image/noop-resizer.js'
import type { ChatMessageContentItem } from '~/core/llm/llm-log-types.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import type { InferenceContext, InferenceRequest, InferenceResponse, LLMError } from '~/core/llm/provider.js'
import { definePlugin } from '~/core/plugins/plugin-builder.js'
import { createTool } from '~/core/tools/definition.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { Ok, type Result } from '~/lib/utils/result.js'
import { createTestPreset, TestHarness, TestSession } from '~/testing/index.js'
import { createNodeFileSystem } from '~/testing/node-platform.js'

const PHOTO_URL = `data:image/jpeg;base64,${Buffer.alloc(300_000, 7).toString('base64')}`
const SCREENSHOT_URL = `data:image/png;base64,${Buffer.alloc(200_000, 9).toString('base64')}`
const base64Of = (url: string) => url.slice(url.indexOf(',') + 1)

/** Hands the agent one user message carrying a photo, as a host plugin delivers an upload. */
const createPhotoPlugin = () => {
	let delivered = false
	return definePlugin('photo-source')
		.dequeue<true>({
			hasPendingMessages: () => !delivered,
			getPendingMessages: () => delivered
				? null
				: { messages: [{ role: 'user', content: [{ type: 'image_url', imageUrl: { url: PHOTO_URL } }, { type: 'text', text: 'What is this?' }] }], token: true },
			markConsumed: async () => {
				delivered = true
			},
		})
		.tools(() => [
			createTool({
				name: 'screenshot',
				description: 'Return a screenshot',
				input: z.object({}),
				execute: async () => Ok([{ type: 'image_url' as const, imageUrl: { url: SCREENSHOT_URL } }]),
			}),
		])
		.build()
}

/** Resolves every image the way the Anthropic and OpenRouter providers do before sending, and records the result. */
class ResolvingProvider extends MockLLMProvider {
	readonly sent: LLMMessage[][] = []
	readonly #images = new DefaultImageProcessor(new NoopImageResizer(), createNodeFileSystem())

	override async inference(request: InferenceRequest, context?: InferenceContext): Promise<Result<InferenceResponse, LLMError>> {
		const resolved = await Promise.all(request.messages.map(async (message): Promise<LLMMessage> => {
			if ((message.role !== 'user' && message.role !== 'tool') || typeof message.content === 'string') return message
			return { ...message, content: await this.#images.resolveContent(message.content, context?.fileStore) }
		}))
		this.sent.push(resolved)
		return super.inference(request)
	}
}

const respond = (request: InferenceRequest): InferenceResponse => {
	const last = request.messages[request.messages.length - 1]
	const metrics = MockLLMProvider.defaultMetrics()
	return last?.role === 'tool'
		? { content: 'Done', toolCalls: [], finishReason: 'stop', metrics }
		: { content: null, toolCalls: [{ id: ToolCallId(`tc${request.messages.length}`), name: 'screenshot', input: {} }], finishReason: 'tool_calls', metrics }
}

const imageUrls = (messages: LLMMessage[]): string[] =>
	messages.flatMap((message) =>
		(message.role === 'user' || message.role === 'tool') && typeof message.content !== 'string'
			? message.content.flatMap((item: ChatMessageContentItem) => item.type === 'image_url' ? [item.imageUrl.url] : [])
			: []
	)

describe('an inline image', () => {
	it('reaches every inference as the same data URL, while the events keep only a stored reference', async () => {
		const provider = new ResolvingProvider(respond)
		const harness = new TestHarness({ presets: [createTestPreset()], systemPlugins: [createPhotoPlugin()], llmProvider: provider })

		const session = await harness.createSession('test')
		await session.sendAndWaitForIdle('Here is a photo.')
		await session.sendAndWaitForIdle('And again?')

		// Two turns of two inferences each; the screenshot joins after the first tool call.
		expect(provider.sent.map(imageUrls)).toEqual([
			[PHOTO_URL],
			[PHOTO_URL, SCREENSHOT_URL],
			[PHOTO_URL, SCREENSHOT_URL],
			[PHOTO_URL, SCREENSHOT_URL, SCREENSHOT_URL],
		])
		for (const url of imageUrls(provider.getCallHistory().flatMap((request) => request.messages))) {
			expect(url).toMatch(/^file:\/\/\.images\/[0-9a-f]{64}\.(jpg|png)$/)
		}
		const events = JSON.stringify(await session.getEvents())
		expect(events).not.toContain(base64Of(PHOTO_URL))
		expect(events).not.toContain(base64Of(SCREENSHOT_URL))

		await harness.shutdown()
	})

	it('stays readable in a fork, which gets its own copy of the stored images', async () => {
		const provider = new ResolvingProvider(respond)
		const harness = new TestHarness({ presets: [createTestPreset()], systemPlugins: [createPhotoPlugin()], llmProvider: provider })

		const source = await harness.createSession('test')
		await source.sendAndWaitForIdle('Here is a photo.')
		const sourceEvents = await source.getEvents()
		const forkResult = await harness.sessionManager.forkSession(source.sessionId, sourceEvents.length - 1)
		if (!forkResult.ok) throw new Error('Expected fork')
		const fork = new TestSession(forkResult.value, harness)

		await fork.sendAndWaitForIdle('Look again.')

		expect(imageUrls(provider.sent[provider.sent.length - 1] ?? [])).toEqual([PHOTO_URL, SCREENSHOT_URL, SCREENSHOT_URL])

		await harness.shutdown()
	})
})
