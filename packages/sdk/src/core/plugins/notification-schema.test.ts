/**
 * Notification schema enforcement
 *
 * `.notification()` declares a contract; a payload that breaks it, or a type that
 * was never declared, must not reach a client.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import z from 'zod/v4'
import { MockLLMProvider } from '~/core/llm/mock.js'
import { Ok } from '~/lib/utils/result.js'
import { createTestPreset, TestHarness } from '~/testing/index.js'
import { definePlugin } from './plugin-builder.js'

/** `min(10)` keeps the bad payload type-correct, so only the runtime check can reject it. */
const declaredPlugin = definePlugin('notify-probe')
	.notification('declared', { schema: z.object({ value: z.number().min(10) }) })
	.method('emitValid', {
		input: z.object({}),
		output: z.object({}),
		handler: async (ctx) => {
			ctx.notify('declared', { value: 42 })
			return Ok({})
		},
	})
	.method('emitInvalid', {
		input: z.object({}),
		output: z.object({}),
		handler: async (ctx) => {
			ctx.notify('declared', { value: 1 })
			return Ok({})
		},
	})
	.build()

/** The session-hook wrapper is a different call site than the method one. */
const sessionHookPlugin = definePlugin('hook-probe')
	.notification('ready', { schema: z.object({ value: z.number().min(10) }) })
	.sessionHook('onSessionReady', async (ctx) => {
		ctx.notify('ready', { value: 42 })
		ctx.notify('ready', { value: 1 })
	})
	.build()

const undeclaredPlugin = definePlugin('undeclared-probe')
	.method('emit', {
		input: z.object({}),
		output: z.object({}),
		handler: async (ctx) => {
			ctx.notify('surprise', { anything: true })
			return Ok({})
		},
	})
	.build()

describe('declared notification schemas', () => {
	let harness: TestHarness

	afterEach(async () => {
		await harness.shutdown()
	})

	function createHarness(): TestHarness {
		harness = new TestHarness({
			presets: [createTestPreset()],
			llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			systemPlugins: [declaredPlugin, sessionHookPlugin, undeclaredPlugin],
		})
		return harness
	}

	it('broadcasts a payload that matches the declared schema', async () => {
		const session = await createHarness().createSession('test')

		const result = await session.callPluginMethod('notify-probe.emitValid', {})

		expect(result.ok).toBe(true)
		expect(harness.notifications.getByType('notify-probe', 'declared')).toHaveLength(1)
	})

	it('drops a payload that fails the declared schema', async () => {
		const session = await createHarness().createSession('test')

		const result = await session.callPluginMethod('notify-probe.emitInvalid', {})

		expect(result.ok).toBe(true)
		expect(harness.notifications.getByType('notify-probe', 'declared')).toHaveLength(0)
	})

	it('checks a session hook the same way as a method handler', async () => {
		await createHarness().createSession('test')

		expect(harness.notifications.getByType('hook-probe', 'ready')).toHaveLength(1)
	})

	it('drops a notification the plugin never declared', async () => {
		const session = await createHarness().createSession('test')

		const result = await session.callPluginMethod('undeclared-probe.emit', {})

		expect(result.ok).toBe(true)
		expect(harness.notifications.getByPlugin('undeclared-probe')).toHaveLength(0)
	})
})
