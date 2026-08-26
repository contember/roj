/**
 * What the HTTP app mounts, and what `/status` claims.
 *
 * Both answers used to be blind: upload and resource routes mounted where their
 * plugins do not exist, and `/status` counted only the sessions that happened to
 * be in memory.
 */

import { describe, expect, test } from 'bun:test'
import z4 from 'zod/v4'
import { bootstrap, createSystemFromServices, type PluginProfile, type Services } from '~/bootstrap.js'
import type { Config } from '~/config.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import type { Preset } from '~/core/preset/index.js'
import type { SessionManager } from '~/core/sessions/session-manager.js'
import { createNodePlatform } from '~/testing/node-platform.js'
import { createTestPreset } from '~/testing/preset-helpers.js'
import { type AppServices, createApp } from './app.js'

function testConfig(): Config {
	return {
		port: 0,
		host: 'localhost',
		dataPath: `/tmp/roj-app-test-${Math.random().toString(36).slice(2)}`,
		persistence: 'memory',
		logLevel: 'error',
		logFormat: 'console',
		llmMock: () => ({ content: 'Mock response', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }),
	}
}

interface Host {
	sessionManager: SessionManager
	app: ReturnType<typeof createApp>
	/** A second runtime over the same event store — what a Durable Object has after an eviction. */
	respawn(): Host
	shutdown(): Promise<void>
}

/** Wire a bootstrapped set of services into the app that serves it. */
function wire(services: Services<'full'> | Services<'isolate'>): Host {
	const system = services.pluginProfile === 'isolate'
		? createSystemFromServices(services)
		: createSystemFromServices(services)
	const appServices: AppServices<PluginProfile> = { ...services, sessionRuntime: system.sessionManager }

	return {
		sessionManager: system.sessionManager,
		app: createApp(appServices),
		respawn: () => wire(services),
		shutdown: () => system.shutdown(),
	}
}

function host(profile: PluginProfile, presets: Preset[]): Host {
	return wire(
		profile === 'isolate'
			? bootstrap(testConfig(), { presets }, createNodePlatform(), { pluginProfile: 'isolate' })
			: bootstrap(testConfig(), { presets }, createNodePlatform()),
	)
}

// Responses are parsed, not asserted — a shape that drifts fails here rather than downstream.
const errorSchema = z4.object({ error: z4.object({ type: z4.string(), message: z4.string() }) })

const statusSchema = z4.object({
	lastActivityAt: z4.number().nullable(),
	stats: z4.object({
		sessionCount: z4.number(),
		loadedSessionCount: z4.number(),
		pendingAgents: z4.number(),
		processingAgents: z4.number(),
		storedSessionCount: z4.number(),
	}),
	sessions: z4.array(z4.object({ id: z4.string() })),
})

const readError = async (response: Response) => errorSchema.parse(await response.json()).error

describe('route mounting follows the plugin profile', () => {
	test('the isolate profile does not mount routes whose plugin it drops', async () => {
		const { app, shutdown } = host('isolate', [])

		try {
			for (const path of ['/sessions/any/upload', '/sessions/any/upload-async', '/sessions/any/upload-from-url', '/sessions/any/inject-resource']) {
				const response = await app.request(path, { method: 'POST' })
				const error = await readError(response)
				expect({ path, status: response.status, type: error.type }).toEqual({ path, status: 404, type: 'not_found' })
				expect(error.message).toStartWith('Route not found:')
			}
		} finally {
			await shutdown()
		}
	})

	test('the full profile mounts them — a missing session, not a missing route', async () => {
		const { app, shutdown } = host('full', [])

		try {
			for (const path of ['/sessions/any/upload', '/sessions/any/inject-resource']) {
				const response = await app.request(path, { method: 'POST' })
				const error = await readError(response)
				expect({ path, status: response.status, type: error.type }).toEqual({ path, status: 404, type: 'session_not_found' })
			}
		} finally {
			await shutdown()
		}
	})

	test('file routes read platform.fs, so they mount under both profiles', async () => {
		for (const profile of ['full', 'isolate'] as const) {
			const { app, shutdown } = host(profile, [])

			try {
				const response = await app.request('/sessions/any/workspace/note.txt')
				const error = await readError(response)
				// 404, but the route's own — the profile-dropped ones answer 'Route not found'.
				expect({ profile, status: response.status, message: error.message }).toEqual({
					profile,
					status: 404,
					message: 'No workspace configured for this session',
				})
			} finally {
				await shutdown()
			}
		}
	})
})

const status = async (host: Host) => statusSchema.parse(await (await host.app.request('/status')).json())

describe('/status separates what is live from what exists', () => {
	test('a loaded session counts in both', async () => {
		const preset = createTestPreset({ id: 'status-live' })
		const live = host('full', [preset])

		try {
			expect((await live.sessionManager.createSession(preset.id)).ok).toBe(true)

			const body = await status(live)
			expect(body.stats).toMatchObject({ sessionCount: 1, storedSessionCount: 1 })
			expect(body.sessions).toHaveLength(1)
		} finally {
			await live.shutdown()
		}
	})

	test('a session the runtime has forgotten still counts as stored', async () => {
		const preset = createTestPreset({ id: 'status-evicted' })
		const live = host('full', [preset])
		expect((await live.sessionManager.createSession(preset.id)).ok).toBe(true)

		// Everything the isolate held goes; the event store does not.
		await live.shutdown()
		const evicted = live.respawn()

		try {
			const body = await status(evicted)
			// Live and durable disagreeing is now readable rather than silent.
			expect(body.stats).toMatchObject({ loadedSessionCount: 0, storedSessionCount: 1 })
		} finally {
			await evicted.shutdown()
		}
	})

	test('storedSessionCount counts closed sessions too', async () => {
		const preset = createTestPreset({ id: 'status-closed' })
		const live = host('full', [preset])

		try {
			const created = await live.sessionManager.createSession(preset.id)
			expect(created.ok).toBe(true)
			if (!created.ok) return
			await created.value.close()

			expect((await status(live)).stats).toMatchObject({ sessionCount: 0, storedSessionCount: 1 })
		} finally {
			await live.shutdown()
		}
	})
})
