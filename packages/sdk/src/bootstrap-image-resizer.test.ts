import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encode as encodePng } from 'fast-png'
import { z } from 'zod'
import { bootstrap } from './bootstrap.js'
import { createBunPlatform } from './bun-platform/index.js'
import type { Config } from './config.js'
import { SessionFileStore } from './core/file-store/file-store.js'
import { readImageDimensions } from './core/image/dimensions.js'
import type { ImageResizeOptions, ImageResizer } from './core/image/types.js'
import { ModelId } from './core/llm/schema.js'
import type { Platform, ProcessRunner } from './platform/index.js'
import { fileUploadSource } from './plugins/uploads/source.js'
import { createTestPreset } from './testing/preset-helpers.js'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function recordingProcess() {
	const commands: string[] = []
	const fail = (command: string): never => {
		commands.push(command)
		throw new Error('this host has no process table')
	}
	const process: ProcessRunner = { spawn: fail, execFile: fail }
	return { process, commands }
}

/** A process runner that runs commands on the host and records their names. */
function recordingHostProcess() {
	const host = createBunPlatform().process
	const commands: string[] = []
	const process: ProcessRunner = {
		spawn: (command, args, options) => {
			commands.push(command)
			return host.spawn(command, args, options)
		},
		execFile: (file, args, options) => {
			commands.push(file)
			return host.execFile(file, args, options)
		},
	}
	return { process, commands }
}

/** A 2500×1250 PNG: over the 2000 px limit a model gets. */
function oversizedPng(): Uint8Array {
	return encodePng({ width: 2500, height: 1250, data: new Uint8Array(2500 * 1250 * 3).fill(200), channels: 3 })
}

const requestBodySchema = z.object({
	messages: z.array(z.object({
		content: z.array(z.object({ type: z.string(), source: z.object({ media_type: z.string(), data: z.string() }).optional() })),
	})),
})

/** Boots with a real Anthropic provider whose HTTP calls are answered locally. */
async function boot(platform: Platform, image: Uint8Array = Buffer.from([0x89, 0x50, 0x4e, 0x47])) {
	const requests: Array<z.infer<typeof requestBodySchema>> = []
	const rejectRequest = async (_input: string | URL | Request, init?: RequestInit) => {
		if (typeof init?.body === 'string') requests.push(requestBodySchema.parse(JSON.parse(init.body)))
		return Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'test' } }, { status: 400 })
	}
	const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(rejectRequest, { preconnect: globalThis.fetch.preconnect }))
	cleanups.push(() => fetchSpy.mockRestore())
	const dataPath = await mkdtemp(join(tmpdir(), 'roj-bootstrap-image-resizer-'))
	cleanups.push(() => rm(dataPath, { recursive: true, force: true }))
	const config: Config = {
		port: 0,
		host: 'localhost',
		dataPath,
		persistence: 'memory',
		logLevel: 'error',
		logFormat: 'console',
		anthropicApiKey: 'test-key',
		llmLoggingEnabled: false,
	}
	const services = bootstrap(config, { presets: [createTestPreset()] }, platform)
	const imagePath = join(dataPath, 'screenshot.png')
	await writeFile(imagePath, image)
	return { services, dataPath, imagePath, requests }
}

/** Dimensions and type of each image the model was sent. */
function imagesSent(host: Awaited<ReturnType<typeof boot>>) {
	return host.requests.flatMap(request =>
		request.messages.flatMap(message =>
			message.content.flatMap(block =>
				block.source === undefined ? [] : [{ mediaType: block.source.media_type, ...readImageDimensions(Buffer.from(block.source.data, 'base64')) }]
			)
		)
	)
}

async function sendImageToModel(host: Awaited<ReturnType<typeof boot>>) {
	const anthropic = host.services.llmProviders.get('anthropic')
	if (!anthropic) throw new Error('Anthropic provider was not registered')
	await anthropic.inference({
		model: ModelId('claude-test'),
		systemPrompt: '',
		messages: [{ role: 'user', content: [{ type: 'image_url', imageUrl: { url: `file://${host.imagePath}` } }] }],
	})
}

async function classifyImage(host: Awaited<ReturnType<typeof boot>>) {
	const classifier = host.services.preprocessorRegistry.getForMimeType('image/png')
	if (!classifier) throw new Error('No image preprocessor registered')
	const files = new SessionFileStore(host.dataPath, undefined, false, host.services.platform.fs, 'session')
	const source = await fileUploadSource(host.services.platform.fs, host.imagePath)
	if (!source.ok) throw source.error
	await classifier.process(source.value, 'image/png', {
		files: files.scoped('upload'),
		uploadId: 'upload',
		sessionId: 'session',
		filename: 'screenshot.png',
		attempt: 1,
	})
}

describe('bootstrap image resizer', () => {
	it('uses the host resizer for model images and upload classification', async () => {
		const trap = recordingProcess()
		const resizeCalls: Array<{ filePath: string; options?: ImageResizeOptions }> = []
		const imageResizer: ImageResizer = {
			async resize(filePath, mimeType, options) {
				resizeCalls.push({ filePath, options })
				return { path: filePath, mimeType }
			},
		}
		const host = await boot({ ...createBunPlatform(), process: trap.process, imageResizer })

		await sendImageToModel(host)
		await classifyImage(host)

		expect(resizeCalls).toEqual([
			{ filePath: host.imagePath, options: { maxFileSizeBytes: 5 * 1024 * 1024, maxDimension: 2000 } },
			{ filePath: host.imagePath, options: expect.objectContaining({ maxDimension: 1024, maxFileSizeBytes: 1024 * 1024 }) },
		])
		expect(trap.commands).toEqual([])
	})

	it('resizes with vips when the host provides no resizer', async () => {
		const trap = recordingProcess()
		const host = await boot({ ...createBunPlatform(), process: trap.process })

		await sendImageToModel(host)
		expect(trap.commands).toEqual(['vipsheader'])

		await classifyImage(host)
		expect(trap.commands).toEqual(['vipsheader', 'vipsheader'])
	})

	it('downscales an oversized image with the vips binaries', async () => {
		const recorder = recordingHostProcess()
		const host = await boot({ ...createBunPlatform(), process: recorder.process }, oversizedPng())

		await sendImageToModel(host)

		expect(recorder.commands).toEqual(['vipsheader', 'vipsthumbnail'])
		expect(imagesSent(host)).toEqual([{ mediaType: 'image/jpeg', width: 2000, height: 1000 }])
	})

	it('downscales an oversized image without vips when the host cannot run it', async () => {
		const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
		cleanups.push(() => warnSpy.mockRestore())
		const trap = recordingProcess()
		const host = await boot({ ...createBunPlatform(), process: trap.process }, oversizedPng())

		await sendImageToModel(host)

		expect(trap.commands).toEqual(['vipsheader'])
		expect(imagesSent(host)).toEqual([{ mediaType: 'image/jpeg', width: 2000, height: 1000 }])
	})
})
