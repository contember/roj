import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Err, Ok, isErr, isOk } from '~/lib/utils/result.js'
import { applyMiddleware } from './middleware.js'
import { MockLLMProvider } from './mock.js'
import type { InferenceRequest, InferenceResponse } from './provider.js'
import { ModelId } from './schema.js'
import { createSnapshotLLMMiddleware } from './snapshot-middleware.js'

describe('SnapshotLLMMiddleware', () => {
	let dir: string

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'roj-snap-'))
	})

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true })
	})

	const request = (overrides: Partial<InferenceRequest> = {}): InferenceRequest => ({
		model: ModelId('test-model'),
		systemPrompt: 'You are a test assistant.',
		messages: [{ role: 'user', content: 'Hello' }],
		...overrides,
	})

	const fixedResponse: InferenceResponse = {
		content: 'Recorded response',
		toolCalls: [],
		finishReason: 'stop',
		metrics: MockLLMProvider.defaultMetrics(),
	}

	test('records on miss and replays on hit without calling next', async () => {
		const downstream = new MockLLMProvider(() => fixedResponse)
		const wrapped = applyMiddleware(downstream, [createSnapshotLLMMiddleware({ snapshotsDir: dir })])

		const first = await wrapped.inference(request())
		expect(isOk(first)).toBe(true)
		expect(downstream.getCallCount()).toBe(1)

		// Snapshot file created
		const files = readdirSync(dir)
		expect(files.length).toBe(1)
		expect(files[0]).toMatch(/^[0-9a-f]{16}\.json$/)

		// Replay — downstream NOT called again
		const second = await wrapped.inference(request())
		expect(isOk(second)).toBe(true)
		if (isOk(second)) {
			expect(second.value.content).toBe('Recorded response')
		}
		expect(downstream.getCallCount()).toBe(1)
	})

	test('distinct requests produce distinct snapshot files', async () => {
		const downstream = new MockLLMProvider(() => fixedResponse)
		const wrapped = applyMiddleware(downstream, [createSnapshotLLMMiddleware({ snapshotsDir: dir })])

		await wrapped.inference(request({ messages: [{ role: 'user', content: 'A' }] }))
		await wrapped.inference(request({ messages: [{ role: 'user', content: 'B' }] }))

		expect(readdirSync(dir).length).toBe(2)
		expect(downstream.getCallCount()).toBe(2)
	})

	test('hash is stable across key-order differences', async () => {
		const downstream = new MockLLMProvider(() => fixedResponse)
		const wrapped = applyMiddleware(downstream, [createSnapshotLLMMiddleware({ snapshotsDir: dir })])

		// Two requests identical in content but constructed with different key order
		await wrapped.inference({
			model: ModelId('m'),
			systemPrompt: 's',
			messages: [{ role: 'user', content: 'x' }],
			temperature: 0.5,
			maxTokens: 100,
		})
		await wrapped.inference({
			maxTokens: 100,
			temperature: 0.5,
			messages: [{ role: 'user', content: 'x' }],
			systemPrompt: 's',
			model: ModelId('m'),
		})

		// Same hash → single snapshot file → downstream called once
		expect(readdirSync(dir).length).toBe(1)
		expect(downstream.getCallCount()).toBe(1)
	})

	test('replay mode errors on miss', async () => {
		const downstream = new MockLLMProvider(() => fixedResponse)
		const wrapped = applyMiddleware(downstream, [
			createSnapshotLLMMiddleware({ snapshotsDir: dir, mode: 'replay' }),
		])

		const result = await wrapped.inference(request())
		expect(isErr(result)).toBe(true)
		if (isErr(result)) {
			expect(result.error.type).toBe('invalid_request')
			expect(result.error.message).toContain('Snapshot not found')
		}
		expect(downstream.getCallCount()).toBe(0)
	})

	test('replay mode serves existing snapshot', async () => {
		// Pre-seed a snapshot by running once in auto mode
		const downstream1 = new MockLLMProvider(() => fixedResponse)
		const recording = applyMiddleware(downstream1, [createSnapshotLLMMiddleware({ snapshotsDir: dir })])
		await recording.inference(request())

		// Now a replay-only chain must hit it
		const downstream2 = new MockLLMProvider(() => {
			throw new Error('should not be called')
		})
		const replaying = applyMiddleware(downstream2, [
			createSnapshotLLMMiddleware({ snapshotsDir: dir, mode: 'replay' }),
		])
		const result = await replaying.inference(request())
		expect(isOk(result)).toBe(true)
		if (isOk(result)) {
			expect(result.value.content).toBe('Recorded response')
		}
	})

	test('record mode overwrites existing snapshot', async () => {
		// Seed with response A
		const downstream1 = new MockLLMProvider(() => ({ ...fixedResponse, content: 'A' }))
		const first = applyMiddleware(downstream1, [createSnapshotLLMMiddleware({ snapshotsDir: dir })])
		await first.inference(request())

		// Force re-record with response B
		const downstream2 = new MockLLMProvider(() => ({ ...fixedResponse, content: 'B' }))
		const second = applyMiddleware(downstream2, [
			createSnapshotLLMMiddleware({ snapshotsDir: dir, mode: 'record' }),
		])
		await second.inference(request())

		// Read back
		const downstream3 = new MockLLMProvider(() => {
			throw new Error('should not be called')
		})
		const third = applyMiddleware(downstream3, [
			createSnapshotLLMMiddleware({ snapshotsDir: dir, mode: 'replay' }),
		])
		const result = await third.inference(request())
		expect(isOk(result)).toBe(true)
		if (isOk(result)) {
			expect(result.value.content).toBe('B')
		}
	})

	test('does not persist error responses', async () => {
		const downstream = new MockLLMProvider(() => {
			const err = { type: 'rate_limit' as const, message: 'throttled' }
			throw err
		})
		const wrapped = applyMiddleware(downstream, [createSnapshotLLMMiddleware({ snapshotsDir: dir })])

		const result = await wrapped.inference(request())
		expect(isErr(result)).toBe(true)
		expect(readdirSync(dir).length).toBe(0)
	})
})
