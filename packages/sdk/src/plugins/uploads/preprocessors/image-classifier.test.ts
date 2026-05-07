import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionFileStore } from '~/core/file-store/file-store.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import { Semaphore } from '~/lib/utils/concurrency.js'
import { silentLogger } from '../../../lib/logger/logger.js'
import { createNodePlatform } from '../../../testing/node-platform.js'
import { ImageClassifierPreprocessor } from './image-classifier.js'

function defer<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
	let resolve!: (v: T) => void
	const promise = new Promise<T>((res) => {
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

		const tasks = imagePaths.map((p, i) =>
			classifier.process(p, 'image/png', { files: fileStore.scoped(`img-${i}-meta`) }),
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
			classifier.process(p, 'image/png', { files: fileStore.scoped(`nogate-${i}-meta`) }),
		)

		await new Promise(r => setTimeout(r, 20))
		expect(active).toBe(N)

		release.resolve()
		await Promise.all(tasks)
		expect(peak).toBe(N)
	})
})
