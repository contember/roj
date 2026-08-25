import { describe, expect, it, spyOn } from 'bun:test'
import { ORCHESTRATOR_ROLE } from '~/core/agents/agent-roles.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import { ModelId } from '~/core/llm/schema.js'
import { createTestPreset, TestHarness } from '~/testing/index.js'

const LUNA = ModelId('openai/gpt-5.6-luna')
const KIMI = ModelId('moonshotai/kimi-k3')

/** Models the mock provider was actually asked for, in call order. */
const modelsUsed = (llmProvider: MockLLMProvider): string[] => llmProvider.getCallHistory().map(request => String(request.model))

const waitUntil = async (predicate: () => boolean, timeoutMs = 1_000): Promise<void> => {
	const deadline = Date.now() + timeoutMs
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error('Timed out waiting for condition')
		await Bun.sleep(5)
	}
}

const newHarness = () =>
	new TestHarness({
		presets: [createTestPreset({ agents: [{ name: 'worker', system: 'worker' }] })],
		llmProvider: MockLLMProvider.withFixedResponse({ content: 'ok', toolCalls: [] }),
	})

describe('session overrides', () => {
	it('uses the preset model when no override is set', async () => {
		const harness = newHarness()
		const session = await harness.createSession('test')

		await session.sendAndWaitForIdle('hello')

		expect(modelsUsed(harness.llmProvider)).toEqual(['mock'])

		await harness.shutdown()
	})

	it('applies an override seeded at session creation', async () => {
		const harness = newHarness()
		const session = await harness.createSession('test', {
			overrides: { agents: { [ORCHESTRATOR_ROLE]: { model: LUNA } } },
		})

		await session.sendAndWaitForIdle('hello')

		expect(modelsUsed(harness.llmProvider)).toEqual([String(LUNA)])

		await harness.shutdown()
	})

	// The point of resolving the model per inference instead of freezing it on the
	// Agent at construction: this agent is already built and has already run a turn.
	it('applies an override set at runtime to an already-running agent', async () => {
		const harness = newHarness()
		const session = await harness.createSession('test')

		await session.sendAndWaitForIdle('before')
		await session.setOverrides({ agents: { [ORCHESTRATOR_ROLE]: { model: LUNA } } })
		await session.sendAndWaitForIdle('after')

		expect(modelsUsed(harness.llmProvider)).toEqual(['mock', String(LUNA)])

		await harness.shutdown()
	})

	it('reverts to the preset model when an override is cleared with null', async () => {
		const harness = newHarness()
		const session = await harness.createSession('test', {
			overrides: { agents: { [ORCHESTRATOR_ROLE]: { model: LUNA } } },
		})

		await session.sendAndWaitForIdle('before')
		await session.setOverrides({ agents: { [ORCHESTRATOR_ROLE]: null } })
		await session.sendAndWaitForIdle('after')

		expect(modelsUsed(harness.llmProvider)).toEqual([String(LUNA), 'mock'])

		await harness.shutdown()
	})

	it('falls back to defaults for an agent with no entry of its own', async () => {
		const harness = newHarness()
		const session = await harness.createSession('test', { overrides: { defaults: { model: KIMI } } })

		await session.sendAndWaitForIdle('hello')

		expect(modelsUsed(harness.llmProvider)).toEqual([String(KIMI)])

		await harness.shutdown()
	})

	it('lets a per-agent entry win over defaults', async () => {
		const harness = newHarness()
		const session = await harness.createSession('test', {
			overrides: { defaults: { model: KIMI }, agents: { [ORCHESTRATOR_ROLE]: { model: LUNA } } },
		})

		await session.sendAndWaitForIdle('hello')

		expect(modelsUsed(harness.llmProvider)).toEqual([String(LUNA)])

		await harness.shutdown()
	})

	it('leaves defaults alone when a patch only touches agents', async () => {
		const harness = newHarness()
		const session = await harness.createSession('test', { overrides: { defaults: { model: KIMI } } })

		await session.setOverrides({ agents: { worker: { model: LUNA } } })
		await session.sendAndWaitForIdle('hello')

		// The orchestrator still resolves through the untouched defaults.
		expect(modelsUsed(harness.llmProvider)).toEqual([String(KIMI)])

		await harness.shutdown()
	})

	it('rejects an override targeting an agent the preset does not define', async () => {
		const harness = newHarness()

		const result = await harness.createSessionResult('test', {
			overrides: { agents: { 'no-such-agent': { model: LUNA } } },
		})

		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.error.message).toContain('no-such-agent')
		}

		await harness.shutdown()
	})

	// The RPC surface the worker actually calls.
	describe('sessions.setOverrides', () => {
		it('sets the override and echoes back the resolved state', async () => {
			const harness = newHarness()
			const session = await harness.createSession('test')

			const result = await harness.sessionManager.callManagerMethod('sessions.setOverrides', {
				sessionId: String(session.sessionId),
				overrides: { agents: { worker: { model: LUNA } }, defaults: { model: KIMI } },
			})

			expect(result.ok).toBe(true)
			if (result.ok) {
				expect(result.value).toEqual({
					agents: { worker: { model: LUNA } },
					defaults: { model: KIMI },
				})
			}

			await harness.shutdown()
		})

		it('rejects an unknown agent name and names what the preset defines', async () => {
			const harness = newHarness()
			const session = await harness.createSession('test')

			const result = await harness.sessionManager.callManagerMethod('sessions.setOverrides', {
				sessionId: String(session.sessionId),
				overrides: { agents: { wrker: { model: LUNA } } },
			})

			expect(result.ok).toBe(false)
			if (!result.ok) {
				expect(result.error.message).toContain('wrker')
				expect(result.error.message).toContain('worker')
			}

			await harness.shutdown()
		})

		it('keeps the runtime leased while the override append is pending', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset({ agents: [{ name: 'worker', system: 'worker' }] })],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'ok', toolCalls: [] }),
				sessionIdleTimeoutMs: 10,
			})
			let releaseAppend: (() => void) | undefined
			let markAppendStarted: (() => void) | undefined
			const appendStarted = new Promise<void>((resolve) => {
				markAppendStarted = resolve
			})
			const appendGate = new Promise<void>((resolve) => {
				releaseAppend = resolve
			})
			const originalAppend = harness.eventStore.append.bind(harness.eventStore)
			const appendSpy = spyOn(harness.eventStore, 'append').mockImplementation(async (sessionId, event) => {
				if (event.type === 'session_overrides_set') {
					markAppendStarted?.()
					await appendGate
				}
				await originalAppend(sessionId, event)
			})

			try {
				const session = await harness.createSession('test')
				const setting = harness.sessionManager.callManagerMethod('sessions.setOverrides', {
					sessionId: String(session.sessionId),
					overrides: { agents: { worker: { model: LUNA } } },
				})

				await appendStarted
				await Bun.sleep(35)
				const duringAppend = harness.sessionManager.getRuntimeCacheStats()
				expect(duringAppend.loadedSessionCount).toBe(1)
				expect(duringAppend.sessions[0]?.leaseReasons).toEqual({ 'manager:sessions.setOverrides': 1 })

				if (!releaseAppend) throw new Error('Append release was not initialized')
				releaseAppend()
				const result = await setting
				expect(result.ok).toBe(true)
				await waitUntil(() => harness.sessionManager.getRuntimeCacheStats().loadedSessionCount === 0)
			} finally {
				releaseAppend?.()
				appendSpy.mockRestore()
				await harness.shutdown()
			}
		})

		it('reports the effective overrides back through sessions.get', async () => {
			const harness = newHarness()
			const session = await harness.createSession('test', {
				overrides: { agents: { [ORCHESTRATOR_ROLE]: { model: LUNA } } },
			})

			const result = await harness.sessionManager.callPluginMethod(
				session.sessionId,
				'sessions.get',
				{ sessionId: String(session.sessionId) },
			)

			expect(result.ok).toBe(true)
			if (result.ok) {
				expect(result.value).toMatchObject({
					overrides: { agents: { [ORCHESTRATOR_ROLE]: { model: LUNA } } },
				})
			}

			await harness.shutdown()
		})
	})

	// Overrides are state like any other, so they must survive a replay rather than
	// living only on the in-memory Session that happened to accept the patch.
	it('reconstructs overrides when the session is reopened from the event store', async () => {
		const harness = newHarness()
		const session = await harness.createSession('test')
		await session.setOverrides({ agents: { [ORCHESTRATOR_ROLE]: { model: LUNA } } })
		await harness.shutdown()

		const restarted = new TestHarness({
			presets: [createTestPreset({ agents: [{ name: 'worker', system: 'worker' }] })],
			llmProvider: MockLLMProvider.withFixedResponse({ content: 'ok', toolCalls: [] }),
			eventStore: harness.eventStore,
		})
		const reopened = await restarted.openSession(session.sessionId)

		await reopened.sendAndWaitForIdle('hello')

		expect(modelsUsed(restarted.llmProvider)).toEqual([String(LUNA)])

		await restarted.shutdown()
	})
})
