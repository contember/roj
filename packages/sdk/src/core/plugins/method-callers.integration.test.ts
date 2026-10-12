import { describe, expect, it } from 'bun:test'
import { MockLLMProvider } from '~/core/llm/mock.js'
import { type CallerSource, definePlugin } from '~/core/plugins/plugin-builder.js'
import { Ok } from '~/lib/utils/result.js'
import { createTestPreset, TestHarness } from '~/testing/index.js'
import z from 'zod/v4'

const createHarness = () => {
	const handled: CallerSource[] = []

	const guarded = definePlugin('guarded')
		.method('configure', {
			input: z.object({ value: z.string() }),
			output: z.object({ ok: z.boolean() }),
			callers: ['system'],
			handler: async (ctx) => {
				handled.push(ctx.caller.source)
				return Ok({ ok: true })
			},
		})
		.method('read', {
			input: z.object({}),
			output: z.object({ ok: z.boolean() }),
			handler: async (ctx) => {
				handled.push(ctx.caller.source)
				return Ok({ ok: true })
			},
		})
		.build()

	const dependent = definePlugin('dependent')
		.dependencies([guarded])
		.method('relay', {
			input: z.object({}),
			output: z.object({ ok: z.boolean() }),
			callers: ['system'],
			handler: async (ctx) => {
				const result = await ctx.deps.guarded.configure({ value: 'x' })
				return Ok({ ok: result.ok })
			},
		})
		.build()

	const harness = new TestHarness({
		presets: [createTestPreset()],
		llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
		systemPlugins: [guarded, dependent],
	})
	return { harness, handled }
}

describe('core: method callers', () => {
	it('rejects a caller outside the list before the handler runs', async () => {
		const { harness, handled } = createHarness()
		const session = await harness.createSession('test')

		for (const source of ['client', 'agent'] as const) {
			const result = await session.callPluginMethod('guarded.configure', { value: 'x' }, { caller: { source, meta: {} } })
			expect(result.ok).toBe(false)
			if (!result.ok) expect(result.error.type).toBe('method_caller_not_allowed')
		}
		expect(handled).toEqual([])

		await harness.shutdown()
	})

	it('counts a call without a caller as client', async () => {
		const { harness, handled } = createHarness()
		const session = await harness.createSession('test')

		const result = await session.callPluginMethod('guarded.configure', { value: 'x' })

		expect(result.ok).toBe(false)
		expect(handled).toEqual([])

		await harness.shutdown()
	})

	it('runs the handler for a listed caller', async () => {
		const { harness, handled } = createHarness()
		const session = await harness.createSession('test')

		const result = await session.callPluginMethod('guarded.configure', { value: 'x' }, { caller: { source: 'system', meta: {} } })

		expect(result).toEqual({ ok: true, value: { ok: true } })
		expect(handled).toEqual(['system'])

		await harness.shutdown()
	})

	it('leaves a method without callers open to every caller', async () => {
		const { harness, handled } = createHarness()
		const session = await harness.createSession('test')

		for (const source of ['client', 'agent', 'system'] as const) {
			const result = await session.callPluginMethod('guarded.read', {}, { caller: { source, meta: {} } })
			expect(result.ok).toBe(true)
		}
		expect(handled).toEqual(['client', 'agent', 'system'])

		await harness.shutdown()
	})

	it('does not pass the outer caller on through deps', async () => {
		const { harness, handled } = createHarness()
		const session = await harness.createSession('test')

		const result = await session.callPluginMethod('dependent.relay', {}, { caller: { source: 'system', meta: {} } })

		expect(result).toEqual({ ok: true, value: { ok: false } })
		expect(handled).toEqual([])

		await harness.shutdown()
	})
})
