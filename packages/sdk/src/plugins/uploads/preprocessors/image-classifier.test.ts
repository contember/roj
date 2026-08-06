import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionFileStore } from '~/core/file-store/file-store.js'
import type { ImageResizer } from '~/core/image/types.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import type { InferenceContext, LLMProvider } from '~/core/llm/provider.js'
import { Semaphore } from '~/lib/utils/concurrency.js'
import { Ok } from '~/lib/utils/result.js'
import { silentLogger } from '../../../lib/logger/logger.js'
import { createNodePlatform } from '../../../testing/node-platform.js'
import { ImageClassifierPreprocessor } from './image-classifier.js'

function defer<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
	let resolve!: (v: T) => void
	const promise = new Promise<T>(res => {
		resolve = res
	})
	return { promise, resolve }
}

describe('ImageClassifierPreprocessor.gate', () => {
	const platform = createNodePlatform()
	let workDir: string

	beforeAll(async () => {
		workDir = await mkdtemp(join(tmpdir(), 'roj-classifier-gate-'))
	})

	afterAll(async () => {
		await rm(workDir, { recursive: true, force: true }).catch(() => {})
	})

	it('caps concurrent vision LLM calls when a gate is provided', async () => {
		const N = 8
		const LIMIT = 3

		// Track concurrency inside the mock LLM handler — each call increments
		// `active` on entry, awaits a release barrier, then decrements on exit.
		let active = 0
		let peak = 0
		const release = defer()

		const llmProvider = new MockLLMProvider(async () => {
			active++
			peak = Math.max(peak, active)
			await release.promise
			active--
			return {
				content: 'desc',
				toolCalls: [],
				finishReason: 'stop',
				metrics: MockLLMProvider.defaultMetrics(),
			}
		})

		const gate = new Semaphore(LIMIT)
		const classifier = new ImageClassifierPreprocessor({
			llmProvider,
			logger: silentLogger,
			fs: platform.fs,
			gate,
		})

		// Create N tiny dummy image files — content doesn't matter, classifier
		// only stats them and hands the path to the (mocked) LLM.
		const imagePaths = await Promise.all(
			Array.from({ length: N }, async (_, i) => {
				const p = join(workDir, `img-${i}.png`)
				await writeFile(p, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
				return p
			}),
		)

		const fileStore = new SessionFileStore(workDir, undefined, false, platform.fs, 'session')
		const signal = new AbortController().signal

		const tasks = imagePaths.map((p, i) =>
			classifier.process(p, 'image/png', {
				files: fileStore.scoped(`img-${i}-meta`),
				signal,
			}),
		)

		// Let the workers queue up; the first LIMIT should be in-flight.
		await new Promise(r => setTimeout(r, 20))
		expect(active).toBeLessThanOrEqual(LIMIT)
		expect(active).toBe(LIMIT)

		// Release everyone; wait for completion and check peak.
		release.resolve()
		const results = await Promise.all(tasks)

		expect(peak).toBe(LIMIT)
		expect(active).toBe(0)
		expect(llmProvider.getCallCount()).toBe(N)
		for (const r of results) {
			expect(r.ok).toBe(true)
		}
	})

	it('does not gate when no semaphore is provided (all run concurrently)', async () => {
		const N = 6
		let active = 0
		let peak = 0
		const release = defer()

		const llmProvider = new MockLLMProvider(async () => {
			active++
			peak = Math.max(peak, active)
			await release.promise
			active--
			return {
				content: 'desc',
				toolCalls: [],
				finishReason: 'stop',
				metrics: MockLLMProvider.defaultMetrics(),
			}
		})

		const classifier = new ImageClassifierPreprocessor({
			llmProvider,
			logger: silentLogger,
			fs: platform.fs,
		})

		const imagePaths = await Promise.all(
			Array.from({ length: N }, async (_, i) => {
				const p = join(workDir, `nogate-${i}.png`)
				await writeFile(p, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
				return p
			}),
		)

		const fileStore = new SessionFileStore(workDir, undefined, false, platform.fs, 'session')

		const tasks = imagePaths.map((p, i) =>
			classifier.process(p, 'image/png', {
				files: fileStore.scoped(`nogate-${i}-meta`),
			}),
		)

		await new Promise(r => setTimeout(r, 20))
		expect(active).toBe(N)

		release.resolve()
		await Promise.all(tasks)
		expect(peak).toBe(N)
	})

	it('aborts while queued without invoking the provider', async () => {
		const gate = new Semaphore(1)
		const holderRelease = defer()
		const holder = gate.run(async () => holderRelease.promise)
		const llmProvider = MockLLMProvider.withFixedResponse({ content: 'desc' })
		const classifier = new ImageClassifierPreprocessor({
			llmProvider,
			logger: silentLogger,
			fs: platform.fs,
			gate,
		})
		const imagePath = join(workDir, 'queued-abort.png')
		await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
		const fileStore = new SessionFileStore(workDir, undefined, false, platform.fs, 'session')
		const controller = new AbortController()
		const reason = new Error('cancel queued classifier')

		const processing = classifier.process(imagePath, 'image/png', {
			files: fileStore.scoped('queued-abort-meta'),
			signal: controller.signal,
		})
		await new Promise(resolve => setTimeout(resolve, 0))
		controller.abort(reason)
		const result = await processing

		expect(result).toEqual({ ok: false, error: reason })
		expect(llmProvider.getCallCount()).toBe(0)
		holderRelease.resolve()
		await holder
	})

	it('deletes a resized temp when cancellation wins after resize', async () => {
		const controller = new AbortController()
		const reason = new Error('cancel after resize')
		const tempPath = join(workDir, 'cancelled-resize.jpg')
		const imagePath = join(workDir, 'cancel-after-resize.png')
		await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
		const imageResizer: ImageResizer = {
			async resize() {
				await writeFile(tempPath, Buffer.from('resized'))
				controller.abort(reason)
				return { path: tempPath, mimeType: 'image/jpeg', tempFile: tempPath }
			},
		}
		const classifier = new ImageClassifierPreprocessor({
			llmProvider: MockLLMProvider.withFixedResponse({ content: 'unused' }),
			logger: silentLogger,
			fs: platform.fs,
			imageResizer,
		})
		const fileStore = new SessionFileStore(workDir, undefined, false, platform.fs, 'session')

		const result = await classifier.process(imagePath, 'image/png', {
			files: fileStore.scoped('cancel-after-resize-meta'),
			signal: controller.signal,
		})

		expect(result).toEqual({ ok: false, error: reason })
		expect(await Bun.file(tempPath).exists()).toBe(false)
	})

	it('deletes a resized temp when reading it fails before ownership is returned', async () => {
		const tempPath = join(workDir, 'unreadable-resize.jpg')
		const missingPath = join(workDir, 'missing-resize.jpg')
		const imagePath = join(workDir, 'read-failure.png')
		await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
		const imageResizer: ImageResizer = {
			async resize() {
				await writeFile(tempPath, Buffer.from('resized'))
				return {
					path: missingPath,
					mimeType: 'image/jpeg',
					tempFile: tempPath,
				}
			},
		}
		const classifier = new ImageClassifierPreprocessor({
			llmProvider: MockLLMProvider.withFixedResponse({
				content: 'fallback description',
			}),
			logger: silentLogger,
			fs: platform.fs,
			imageResizer,
		})
		const fileStore = new SessionFileStore(workDir, undefined, false, platform.fs, 'session')

		const result = await classifier.process(imagePath, 'image/png', {
			files: fileStore.scoped('read-failure-meta'),
		})

		expect(result.ok).toBe(true)
		expect(await Bun.file(tempPath).exists()).toBe(false)
	})

	it('passes the preprocessing signal to provider inference context', async () => {
		const contexts: Array<InferenceContext | undefined> = []
		const llmProvider: LLMProvider = {
			name: 'context-capture',
			async inference(_request, context) {
				contexts.push(context)
				return Ok({
					content: 'desc',
					toolCalls: [],
					finishReason: 'stop',
					metrics: MockLLMProvider.defaultMetrics(),
				})
			},
		}
		const classifier = new ImageClassifierPreprocessor({
			llmProvider,
			logger: silentLogger,
			fs: platform.fs,
		})
		const imagePath = join(workDir, 'provider-signal.png')
		await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
		const fileStore = new SessionFileStore(workDir, undefined, false, platform.fs, 'session')
		const controller = new AbortController()
		const inferenceContext = {
			sessionId: 'session',
			agentId: 'agent',
			fileStore,
		}

		const result = await classifier.process(imagePath, 'image/png', {
			files: fileStore.scoped('provider-signal-meta'),
			signal: controller.signal,
			inferenceContext,
		})

		expect(result.ok).toBe(true)
		expect(contexts).toHaveLength(1)
		expect(contexts[0]?.signal).toBe(controller.signal)
	})
})
