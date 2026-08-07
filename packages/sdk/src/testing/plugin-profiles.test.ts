import { describe, expect, test } from 'bun:test'
import { bootstrap, createSystemFromServices, fullPlugins, isolatePlugins } from '~/bootstrap.js'
import type { Config } from '~/config.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import { createNodePlatform } from './node-platform.js'
import { createTestPreset } from './preset-helpers.js'
import { TestHarness } from './test-harness.js'

/** Plugins the isolate profile drops — each one shells out to a binary. */
const PROCESS_DEPENDENT = ['uploads', 'resources', 'services', 'git-status']

function testConfig(): Config {
	return {
		port: 0,
		host: 'localhost',
		dataPath: `/tmp/roj-profile-test-${Math.random().toString(36).slice(2)}`,
		persistence: 'memory',
		logLevel: 'error',
		logFormat: 'console',
		llmMock: () => ({
			content: 'Mock response',
			toolCalls: [],
			finishReason: 'stop',
			metrics: MockLLMProvider.defaultMetrics(),
		}),
	}
}

describe('plugin profiles', () => {
	test('isolate omits exactly the process-dependent built-ins', () => {
		const fullNames: string[] = fullPlugins.map(p => p.name)
		const isolateNames: string[] = isolatePlugins.map(p => p.name)

		expect(isolateNames.filter(name => PROCESS_DEPENDENT.includes(name))).toEqual([])
		expect(fullNames.filter(name => !isolateNames.includes(name)).sort()).toEqual([...PROCESS_DEPENDENT].sort())
	})

	test('bootstrap defaults to the full profile', () => {
		const services = bootstrap(testConfig(), { presets: [] }, createNodePlatform())
		expect(services.pluginProfile).toBe('full')

		const system = createSystemFromServices(services)
		expect(Object.keys(system.plugins).sort()).toEqual([...fullPlugins.map(p => p.name)].sort())
	})

	test('isolate profile registers only the isolate set', () => {
		const services = bootstrap(testConfig(), { presets: [] }, createNodePlatform(), { pluginProfile: 'isolate' })
		expect(services.pluginProfile).toBe('isolate')

		const system = createSystemFromServices(services)
		expect(Object.keys(system.plugins).sort()).toEqual([...isolatePlugins.map(p => p.name)].sort())

		const schemaPlugins = new Set(Object.keys(system.methodSchemas).map(m => m.slice(0, m.indexOf('.'))))
		for (const name of PROCESS_DEPENDENT) {
			expect(schemaPlugins.has(name)).toBe(false)
		}
	})

	test('an omitted plugin method returns method-not-found, not a crash', async () => {
		const preset = createTestPreset({ id: 'isolate-test' })
		const services = bootstrap(testConfig(), { presets: [preset] }, createNodePlatform(), { pluginProfile: 'isolate' })
		const system = createSystemFromServices(services)

		try {
			const created = await system.sessionManager.createSession(preset.id)
			expect(created.ok).toBe(true)
			if (!created.ok) return

			const session = created.value
			expect(session.getPluginMethods().has('services.start')).toBe(false)

			const result = await session.callPluginMethod('services.start', { sessionId: String(session.id), all: true })
			expect(result.ok).toBe(false)
			if (result.ok) return
			expect(result.error.type).toBe('validation_error')
			expect(result.error.message).toBe('Unknown plugin: services')
		} finally {
			await system.shutdown()
		}
	})

	test('TestHarness still registers the process-dependent built-ins', async () => {
		const preset = createTestPreset({ id: 'harness-parity' })
		const harness = new TestHarness({ presets: [preset] })

		try {
			const created = await harness.createSession(preset.id)
			const found = await harness.sessionManager.getSession(created.sessionId)
			expect(found.ok).toBe(true)
			if (!found.ok) return

			// Only these two are observable here: git-status exposes no RPC methods and
			// services is skipped by isSessionEnabled when the preset configures none.
			const methodPlugins = new Set([...found.value.getPluginMethods().keys()].map(m => m.slice(0, m.indexOf('.'))))
			for (const name of ['uploads', 'resources']) {
				expect(methodPlugins.has(name)).toBe(true)
			}
		} finally {
			await harness.shutdown()
		}
	})
})
