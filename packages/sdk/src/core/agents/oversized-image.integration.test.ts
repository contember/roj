import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import z from 'zod/v4'
import { readImageDimensions } from '~/core/image/dimensions.js'
import { DefaultImageProcessor } from '~/core/image/image-processor.js'
import { NoopImageResizer } from '~/core/image/noop-resizer.js'
import type { ImageResizer } from '~/core/image/types.js'
import { VipsImageResizer } from '~/core/image/vips-resizer.js'
import { AnthropicProvider } from '~/core/llm/anthropic.js'
import type { ChatMessageContentItem } from '~/core/llm/llm-log-types.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import { OpenRouterProvider } from '~/core/llm/openrouter.js'
import type { InferenceContext, InferenceRequest, InferenceResponse, LLMError, LLMProvider } from '~/core/llm/provider.js'
import { ModelId } from '~/core/llm/schema.js'
import { definePlugin } from '~/core/plugins/plugin-builder.js'
import { createTool } from '~/core/tools/definition.js'
import { Ok, type Result } from '~/lib/utils/result.js'
import { createTestPreset, TestHarness } from '~/testing/index.js'
import { createNodeFileSystem, createNodeProcessRunner } from '~/testing/node-platform.js'

/** A black grayscale PNG of the given size. */
function png(width: number, height: number): Buffer {
	const chunk = (type: string, data: Buffer) => {
		const typed = Buffer.concat([Buffer.from(type, 'latin1'), data])
		const length = Buffer.alloc(4)
		length.writeUInt32BE(data.length)
		const checksum = Buffer.alloc(4)
		checksum.writeUInt32BE(crc32(typed))
		return Buffer.concat([length, typed, checksum])
	}
	const header = Buffer.alloc(13)
	header.writeUInt32BE(width, 0)
	header.writeUInt32BE(height, 4)
	header[8] = 8 // bit depth; colour type 0 (grayscale), default compression, filter and interlace follow as zeros
	// Each row is a filter byte (0) and `width` pixels.
	const pixels = deflateSync(Buffer.alloc((width + 1) * height))
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', pixels), chunk('IEND', Buffer.alloc(0))])
}

const pngDataUrl = (width: number, height: number) => `data:image/png;base64,${png(width, height).toString('base64')}`

const vipsResizer = (): ImageResizer => new VipsImageResizer({ fs: createNodeFileSystem(), process: createNodeProcessRunner(), tmpDir: tmpdir() })

/** Runs the agent against a real provider adapter; the harness takes a mock provider only. */
class AdapterUnderTest extends MockLLMProvider {
	readonly #adapter: LLMProvider

	constructor(adapter: LLMProvider) {
		super(() => {
			throw new Error('the adapter answers every request')
		})
		this.#adapter = adapter
	}

	override inference(request: InferenceRequest, context?: InferenceContext): Promise<Result<InferenceResponse, LLMError>> {
		return this.#adapter.inference(request, context)
	}
}

interface AnthropicBlock {
	type: string
	text?: string
	source?: { type: string; data?: string }
	content?: string | AnthropicBlock[]
}

interface AnthropicBody {
	messages: Array<{ role: string; content: string | AnthropicBlock[] }>
}

/** Every image block of a request body, nested ones in tool results included. */
const imageBlocks = (body: AnthropicBody): AnthropicBlock[] =>
	body.messages.flatMap((message) => typeof message.content === 'string' ? [] : message.content).flatMap((block) =>
		block.type === 'image' ? [block] : block.type === 'tool_result' && typeof block.content !== 'string' ? (block.content ?? []).filter((nested) => nested.type === 'image') : []
	)

const dimensionsOf = (block: AnthropicBlock) => {
	if (block.source?.type !== 'base64' || block.source.data === undefined) throw new Error('expected a base64 image')
	return readImageDimensions(Buffer.from(block.source.data, 'base64'))
}

const anthropicMessage = (content: Array<Record<string, unknown>>, stopReason: string) =>
	Response.json({
		id: 'msg_test',
		type: 'message',
		role: 'assistant',
		content,
		model: 'claude-test',
		stop_reason: stopReason,
		usage: { input_tokens: 10, output_tokens: 5 },
	})

/**
 * Anthropic behind a fake fetch: it answers a request without a tool result with a call to `screenshot`, and one with
 * a tool result with "Done"; `reject` may answer a request with an error response instead. Records every request body.
 */
function fakeAnthropic(resizer: ImageResizer, reject: (body: AnthropicBody) => Response | undefined = () => undefined) {
	const bodies: AnthropicBody[] = []
	const provider = new AnthropicProvider({
		apiKey: 'test-key',
		imageProcessor: new DefaultImageProcessor(resizer, createNodeFileSystem()),
		fetch: async (_input, init) => {
			const body: AnthropicBody = JSON.parse(String(init?.body))
			bodies.push(body)
			const rejection = reject(body)
			if (rejection !== undefined) return rejection
			const last = body.messages[body.messages.length - 1]
			const answersTool = typeof last?.content !== 'string' && (last?.content ?? []).some((block) => block.type === 'tool_result')
			return answersTool
				? anthropicMessage([{ type: 'text', text: 'Done' }], 'end_turn')
				: anthropicMessage([{ type: 'tool_use', id: `toolu_${bodies.length}`, name: 'screenshot', input: {} }], 'tool_use')
		},
	})
	return { provider: new AdapterUnderTest(provider), bodies }
}

interface OpenRouterBody {
	messages: Array<{ role: string; content: string | Array<{ type: string; image_url?: { url: string } }> }>
}

/** OpenRouter behind a fake fetch, answering as `fakeAnthropic` does. */
function fakeOpenRouter(resizer: ImageResizer) {
	const bodies: OpenRouterBody[] = []
	const provider = new OpenRouterProvider({
		apiKey: 'test-key',
		imageProcessor: new DefaultImageProcessor(resizer, createNodeFileSystem()),
		fetch: async (_input, init) => {
			const body: OpenRouterBody = JSON.parse(String(init?.body))
			bodies.push(body)
			const message = body.messages[body.messages.length - 1]?.role === 'tool'
				? { content: 'Done' }
				: { content: null, tool_calls: [{ id: `call_${bodies.length}`, type: 'function', function: { name: 'screenshot', arguments: '{}' } }] }
			return Response.json({
				id: 'gen_test',
				model: 'anthropic/claude-test',
				choices: [{ message, finish_reason: message.content === null ? 'tool_calls' : 'stop' }],
				usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
			})
		},
	})
	return { provider: new AdapterUnderTest(provider), bodies }
}

/** Dimensions of every image a request body carries, in OpenRouter's format. */
const openRouterImageDimensions = (body: OpenRouterBody) =>
	body.messages.flatMap((message) => typeof message.content === 'string' ? [] : message.content).flatMap((item) =>
		item.image_url === undefined ? [] : [readImageDimensions(Buffer.from(item.image_url.url.slice(item.image_url.url.indexOf(',') + 1), 'base64'))]
	)

/** Delivers one user message carrying `upload` and offers a `screenshot` tool that returns a caption and `screenshot`. */
function imageSourcePlugin(upload: string | undefined, screenshot: string) {
	let delivered = upload === undefined
	return definePlugin('image-source')
		.dequeue<true>({
			hasPendingMessages: () => !delivered,
			getPendingMessages: () =>
				delivered || upload === undefined
					? null
					: { messages: [{ role: 'user', content: [{ type: 'image_url', imageUrl: { url: upload } }, { type: 'text', text: 'An upload.' }] }], token: true },
			markConsumed: async () => {
				delivered = true
			},
		})
		.tools(() => [
			createTool({
				name: 'screenshot',
				description: 'Return a screenshot',
				input: z.object({}),
				execute: async () =>
					Ok<ChatMessageContentItem[]>([{ type: 'text', text: 'The page:' }, { type: 'image_url', imageUrl: { url: screenshot } }]),
			}),
		])
		.build()
}

describe('an image over the dimension limit', () => {
	const providers = [
		{
			name: 'Anthropic',
			create: () => {
				const { provider, bodies } = fakeAnthropic(vipsResizer())
				return { provider, sentDimensions: () => imageBlocks(bodies[bodies.length - 1]).map(dimensionsOf) }
			},
		},
		{
			name: 'OpenRouter',
			create: () => {
				const { provider, bodies } = fakeOpenRouter(vipsResizer())
				return { provider, sentDimensions: () => openRouterImageDimensions(bodies[bodies.length - 1]) }
			},
		},
	]
	for (const { name, create } of providers) {
		it(`reaches ${name} with its long edge at 2000 px, as an upload and as a tool result`, async () => {
			const { provider, sentDimensions } = create()
			const harness = new TestHarness({
				presets: [createTestPreset()],
				systemPlugins: [imageSourcePlugin(pngDataUrl(3500, 1000), pngDataUrl(1000, 3500))],
				llmProvider: provider,
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Look at these.')

			expect(sentDimensions()).toEqual([{ width: 2000, height: 571 }, { width: 571, height: 2000 }])

			await harness.shutdown()
		})
	}

	it('reaches the provider from a file path with its long edge at 2000 px, and a smaller image is not enlarged', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'roj-oversized-image-'))
		await Bun.write(join(dir, 'large.png'), png(3500, 1000))
		await Bun.write(join(dir, 'small.png'), png(500, 300))

		const resolved = await new DefaultImageProcessor(vipsResizer(), createNodeFileSystem()).resolveContent([
			{ type: 'image_url', imageUrl: { url: `file://${join(dir, 'large.png')}` } },
			{ type: 'image_url', imageUrl: { url: `file://${join(dir, 'small.png')}` } },
		])

		if (typeof resolved === 'string') throw new Error('expected content items')
		expect(resolved.map((item) => item.type === 'image_url' ? readImageDimensions(Buffer.from(item.imageUrl.url.split(',')[1], 'base64')) : item)).toEqual([
			{ width: 2000, height: 571 },
			{ width: 500, height: 300 },
		])

		await rm(dir, { recursive: true, force: true })
	})

	it('is downscaled through the resizer when it is inline, as a direct provider call sends it, and a smaller one is sent as it is', async () => {
		const processor = new DefaultImageProcessor(vipsResizer(), createNodeFileSystem(), { maxFileSizeBytes: 5 * 1024 * 1024, tmpDir: tmpdir() })
		const resolved = await processor.resolveContent([
			{ type: 'image_url', imageUrl: { url: pngDataUrl(3500, 1000) } },
			{ type: 'image_url', imageUrl: { url: pngDataUrl(500, 300) } },
		])

		if (typeof resolved === 'string') throw new Error('expected content items')
		const [large, small] = resolved
		if (large?.type !== 'image_url') throw new Error(`expected an image, got ${JSON.stringify(large)}`)
		expect(large.imageUrl.url).toStartWith('data:image/jpeg;base64,')
		expect(readImageDimensions(Buffer.from(large.imageUrl.url.split(',')[1], 'base64'))).toEqual({ width: 2000, height: 571 })
		expect(small).toEqual({ type: 'image_url', imageUrl: { url: pngDataUrl(500, 300) } })
	})

	it('becomes a note when no resizer can shrink it', async () => {
		const { provider, bodies } = fakeAnthropic(new NoopImageResizer())
		const harness = new TestHarness({ presets: [createTestPreset()], systemPlugins: [imageSourcePlugin(pngDataUrl(3500, 1000), pngDataUrl(20, 10))], llmProvider: provider })

		const session = await harness.createSession('test')
		await session.sendAndWaitForIdle('Look at these.')

		const last = bodies[bodies.length - 1]
		expect(imageBlocks(last).map(dimensionsOf)).toEqual([{ width: 20, height: 10 }])
		expect(JSON.stringify(last)).toContain('3500x1000 px, over the 2000 px limit, and it could not be downscaled')

		await harness.shutdown()
	})
})

/** The provider's answer to a request whose images are too large, as the Messages API returns it, naming each image's path. */
const imageDimensionsRejection = (paths: string[]) =>
	JSON.stringify({
		type: 'error',
		error: {
			type: 'invalid_request_error',
			message: `${paths.join(', ')}: At least one of the image dimensions exceed max allowed size for many-image requests: 3000 pixels`,
		},
		error_code: 'image_dimensions_too_large',
		request_id: 'req_test',
	})

/** The fixture: the rejection of a request whose third message is a tool result with an image after its caption. */
const IMAGE_DIMENSIONS_REJECTION = imageDimensionsRejection(['messages.2.content.0.content.1'])

/** Paths of the image blocks in tool results, in the form the provider names them. */
const toolResultImagePaths = (body: AnthropicBody): string[] =>
	body.messages.flatMap((message, i) =>
		typeof message.content === 'string' ? [] : message.content.flatMap((block, j) =>
			block.type === 'tool_result' && typeof block.content !== 'string'
				? (block.content ?? []).flatMap((nested, k) => nested.type === 'image' ? [`messages.${i}.content.${j}.content.${k}`] : [])
				: []
		)
	)

describe('a provider rejection of an image', () => {
	it('is recovered from on every turn: the request is resent with the image replaced and the agent never pauses', async () => {
		// Rejects every request that still carries a screenshot, as the provider does for as long as it stays in history,
		// and names only the first one, so a request with several screenshots is rejected once per screenshot.
		const rejections: string[] = []
		const { provider, bodies } = fakeAnthropic(new NoopImageResizer(), (body) => {
			const [first] = toolResultImagePaths(body)
			if (first === undefined) return undefined
			rejections.push(imageDimensionsRejection([first]))
			return new Response(imageDimensionsRejection([first]), { status: 400 })
		})
		const harness = new TestHarness({ presets: [createTestPreset()], systemPlugins: [imageSourcePlugin(undefined, pngDataUrl(40, 30))], llmProvider: provider })

		const session = await harness.createSession('test')
		await session.sendAndWaitForIdle('Take a screenshot.')

		// The tool result turn: rejected, then resent with the named image replaced.
		const [, rejected, resent] = bodies
		const toolResult = (body: AnthropicBody) => {
			const content = body.messages[2]?.content
			return typeof content === 'string' ? undefined : content?.[0]
		}
		expect(rejections[0]).toBe(IMAGE_DIMENSIONS_REJECTION)
		expect(toolResult(rejected)?.type).toBe('tool_result')
		expect(imageBlocks(rejected)).toHaveLength(1)
		expect(toolResult(resent)?.content).toEqual([
			{ type: 'text', text: 'The page:' },
			{ type: 'text', text: '[Image omitted: the model provider rejected it]' },
		])
		expect(imageBlocks(resent)).toEqual([])

		// More turns than the pause threshold of consecutive rejected turns; each one is rejected once and resent.
		for (let turn = 0; turn < 4; turn++) await session.sendAndWaitForIdle(`Turn ${turn}.`)

		// Later turn n (1-4) makes two inferences, the screenshot call with n screenshots in history and the answer with
		// n + 1; each request is rejected once per screenshot, then accepted.
		expect(bodies.length).toBe(3 + [1, 2, 3, 4].reduce((sum, n) => sum + (n + 1) + (n + 2), 0))
		expect(bodies.filter((body) => imageBlocks(body).length > 0)).toHaveLength(rejections.length)
		expect(await session.getEventsByType('inference_failed')).toEqual([])
		expect(await session.getEventsByType('agent_paused')).toEqual([])

		await harness.shutdown()
	})

	it('without paths, drops the remote images first, then every image', async () => {
		// The code alone, as a rejection might carry it without naming the blocks.
		const pathless = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'image dimensions exceed the limit' }, error_code: 'image_dimensions_too_large' })
		const inline = pngDataUrl(40, 30)
		const sources = (body: AnthropicBody) => imageBlocks(body).map((block) => block.source?.type)
		const { provider, bodies } = fakeAnthropic(new NoopImageResizer(), (body) =>
			imageBlocks(body).length > 0 ? new Response(pathless, { status: 400 }) : undefined)

		const result = await provider.inference({
			model: ModelId('claude-test'),
			systemPrompt: 'test',
			messages: [{
				role: 'user',
				content: [{ type: 'image_url', imageUrl: { url: 'https://example.com/large.png' } }, { type: 'image_url', imageUrl: { url: inline } }, {
					type: 'text',
					text: 'hello',
				}],
			}],
		})

		expect(result.ok).toBe(true)
		expect(bodies.map(sources)).toEqual([['url', 'base64'], ['base64'], []])
	})

	it('is returned as it is when it names no image', async () => {
		const notAnImage = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'messages.0.content.0: some other problem' } })
		const { provider, bodies } = fakeAnthropic(new NoopImageResizer(), () => new Response(notAnImage, { status: 400 }))

		const result = await provider.inference({ model: ModelId('claude-test'), systemPrompt: 'test', messages: [{ role: 'user', content: 'hello' }] })

		expect(result.ok ? undefined : result.error.type).toBe('invalid_request')
		expect(bodies).toHaveLength(1)
	})

	it('is returned as it is when it is another kind of rejection, even one naming an image', async () => {
		const tooLong = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'messages.0.content.0: prompt is too long: 210000 tokens > 200000 maximum' } })
		const { provider, bodies } = fakeAnthropic(new NoopImageResizer(), () => new Response(tooLong, { status: 400 }))

		const result = await provider.inference({
			model: ModelId('claude-test'),
			systemPrompt: 'test',
			messages: [{ role: 'user', content: [{ type: 'image_url', imageUrl: { url: pngDataUrl(40, 30) } }, { type: 'text', text: 'hello' }] }],
		})

		expect(result.ok ? undefined : result.error.type).toBe('context_length')
		expect(bodies).toHaveLength(1)
		expect(imageBlocks(bodies[0])).toHaveLength(1)
	})
})
