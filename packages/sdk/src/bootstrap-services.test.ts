import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from 'zod/v4'
import { bootstrap, createSystemFromServices, type PluginProfile } from './bootstrap.js'
import { createBunPlatform } from './bun-platform/index.js'
import type { Config } from './config.js'
import { MemoryEventStore } from './core/events/memory.js'
import type { DomainEvent } from './core/events/types.js'
import { MockLLMProvider } from './core/llm/mock.js'
import type { Preset } from './core/preset/index.js'
import { selectPluginState } from './core/sessions/reducer.js'
import type { SessionId } from './core/sessions/schema.js'
import type { Session } from './core/sessions/session.js'
import type { Platform, ProcessRunner } from './platform/index.js'
import { servicePlugin } from './plugins/services/plugin.js'
import { PortPool } from './plugins/services/port-pool.js'
import type { ServiceConfig, ServiceEntry } from './plugins/services/schema.js'
import { ServiceExecutor, setServiceExecutorObserverForTesting } from './plugins/services/service.js'
import { NotificationCollector } from './testing/notification-collector.js'
import { createTestPreset } from './testing/preset-helpers.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function processTrap() {
	let calls = 0
	const forbidden = (): never => {
		calls++
		throw new Error('Host process API must not be used')
	}
	const process: ProcessRunner = { spawn: forbidden, execFile: forbidden }
	return { process, calls: () => calls }
}

const service: ServiceConfig = {
	type: 'preview',
	description: 'Bootstrap lifecycle test service',
	command: 'echo READY; exec sleep 60',
	readyPattern: 'READY',
}

function servicesPreset(config: ServiceConfig = service): Preset {
	const preset = createTestPreset()
	preset.orchestrator.services = [config]
	return preset
}

async function boot(
	platform: Platform,
	preset: Preset,
	profile: PluginProfile = 'full',
	options: { eventStore?: MemoryEventStore; sessionIdleTimeoutMs?: number } = {},
) {
	const eventStore = options.eventStore ?? new MemoryEventStore()
	const dataPath = await mkdtemp(join(tmpdir(), 'roj-bootstrap-services-'))
	const config: Config = {
		port: 0,
		host: 'localhost',
		dataPath,
		persistence: 'memory',
		logLevel: 'error',
		logFormat: 'console',
		sessionIdleTimeoutMs: options.sessionIdleTimeoutMs,
		llmMock: () => ({ content: 'Ok', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }),
	}
	const services =
		profile === 'isolate'
			? bootstrap(config, { presets: [preset] }, platform, { pluginProfile: 'isolate', eventStore })
			: bootstrap(config, { presets: [preset] }, platform, { eventStore })
	const notifications = new NotificationCollector()
	const systemOptions = { onUserOutput: notifications.push.bind(notifications) }
	// The overloads accept concrete profiles, so narrow the union before calling.
	const system = services.pluginProfile === 'isolate' ? createSystemFromServices(services, systemOptions) : createSystemFromServices(services, systemOptions)
	cleanups.push(async () => {
		await system.shutdown()
		await rm(dataPath, { recursive: true, force: true })
	})
	return {
		eventStore,
		services,
		system,
		notifications,
		async createSession() {
			const result = await system.sessionManager.createSession(preset.id)
			if (!result.ok) throw new Error(result.error.message)
			return result.value
		},
	}
}

async function waitFor(condition: () => boolean) {
	const deadline = Date.now() + 3000
	while (!condition()) {
		if (Date.now() > deadline) throw new Error('Timed out waiting for service lifecycle')
		await Bun.sleep(10)
	}
}

function entry(session: Session) {
	return selectPluginState<Map<string, ServiceEntry>>(session.state, 'services')?.get(service.type)
}

function serviceNotifications(collector: NotificationCollector) {
	const schema = z.object({ sessionId: z.string(), status: z.string(), port: z.number().optional() })
	return collector
		.getAll()
		.filter((notification) => notification.type === 'serviceStatus')
		.map((notification) => schema.parse(notification.payload))
}

async function serviceStatuses(store: MemoryEventStore, sessionId: SessionId) {
	const schema = z.object({ toStatus: z.string(), stoppedBy: z.string().optional() })
	return (await store.getEventsByType(sessionId, 'service_status_changed')).map((event) => schema.parse(event))
}

class GatedStatusStore extends MemoryEventStore {
	private gate: ReturnType<typeof Promise.withResolvers<void>> | undefined
	blocked = false

	arm() {
		this.blocked = false
		this.gate = Promise.withResolvers<void>()
	}

	release() {
		this.gate?.resolve()
		this.gate = undefined
	}

	override async append(sessionId: SessionId, event: DomainEvent): Promise<void> {
		if (this.gate && event.type === 'service_status_changed') {
			this.blocked = true
			await this.gate.promise
		}
		await super.append(sessionId, event)
	}
}

describe('bootstrap services executor selection', () => {
	it('uses the native executor and durable PID registry by default on Bun', async () => {
		const executors: ServiceExecutor[] = []
		const restore = setServiceExecutorObserverForTesting((executor) => executors.push(executor))
		try {
			const host = await boot(createBunPlatform(), servicesPreset({ ...service, autoStart: true }))
			const session = await host.createSession()
			await waitFor(() => entry(session)?.status === 'ready')
			expect(host.services.pluginProfile).toBe('full')
			expect(executors).toHaveLength(1)
			expect(executors[0]).toBeInstanceOf(ServiceExecutor)
			const running = entry(session)
			if (running?.pid === undefined || running.port === undefined) throw new Error('Missing native pid or port')
			const pid = running.pid
			expect(() => process.kill(pid, 0)).not.toThrow()
			const record = Bun.file(join(host.services.config.dataPath, 'service-pids', `${session.id}__${service.type}.json`))
			expect(await record.json()).toMatchObject({ sessionId: session.id, serviceType: service.type, pid })
			expect(host.services.portPool.tryAllocate(running.port)).toBe(false)
			await host.system.shutdown()
			expect(() => process.kill(pid, 0)).toThrow()
			expect(await record.exists()).toBe(false)
			expect(host.services.portPool.tryAllocate(running.port)).toBe(true)
			host.services.portPool.release(running.port)
			const events = await serviceStatuses(host.eventStore, session.id)
			expect(events.map((event) => event.toStatus)).toEqual(['starting', 'ready', 'stopping', 'stopped'])
			expect(events.at(-1)?.stoppedBy).toBe('eviction')
			expect(executors[0]?.onStatusChanged).toBeUndefined()
			expect(executors[0]?.onStartSettled).toBeUndefined()
		} finally {
			restore()
		}
	})

	for (const profile of ['full', 'isolate'] satisfies PluginProfile[]) {
		it(`uses a separate supplied executor per ${profile} session and drains status publications on shutdown`, async () => {
			const native = createBunPlatform()
			const trap = processTrap()
			const executors: ServiceExecutor[] = []
			const pools: PortPool[] = []
			const platform: Platform = {
				...native,
				process: trap.process,
				createServiceExecutor(logger, pool) {
					pools.push(pool)
					const executor = new ServiceExecutor(logger, pool, native)
					executors.push(executor)
					return executor
				},
			}
			const store = new GatedStatusStore()
			const host = await boot(platform, servicesPreset(), profile, { eventStore: store })
			const first = await host.createSession()
			const second = await host.createSession()
			expect(executors).toHaveLength(2)
			expect(executors[0]).not.toBe(executors[1])
			expect(pools).toEqual([host.services.portPool, host.services.portPool])
			store.arm()
			try {
				const started = await first.callPluginMethod('services.start', { serviceType: service.type, waitForReady: true })
				expect(started.ok).toBe(true)
				await waitFor(() => store.blocked)
				expect(host.system.sessionManager.getRuntimeCacheStats().sessions.find((session) => session.id === first.id)?.leaseReasons).toEqual({
					'service:preview': 1,
				})
				expect(await store.getEventsByType(first.id, 'service_status_changed')).toHaveLength(0)
				expect(serviceNotifications(host.notifications)).toHaveLength(0)
			} finally {
				store.release()
			}
			for (const session of [first, second]) {
				const started = await session.callPluginMethod('services.start', { serviceType: service.type, waitForReady: true })
				expect(started.ok).toBe(true)
				await waitFor(() => entry(session)?.status === 'ready')
			}
			const firstPort = entry(first)?.port
			const secondPort = entry(second)?.port
			if (firstPort === undefined || secondPort === undefined) throw new Error('Missing service ports')
			expect(firstPort).not.toBe(secondPort)
			await waitFor(() => host.system.sessionManager.getRuntimeCacheStats().sessions.every((session) => session.activeLeaseCount === 0))
			const stopped = await first.callPluginMethod('services.stop', { serviceType: service.type })
			expect(stopped.ok).toBe(true)
			await waitFor(() => entry(first)?.status === 'stopped')
			expect(entry(first)?.stoppedBy).toBe('agent')
			expect(executors[1]?.getStatus(service.type)).toBe('ready')
			const restarted = await first.callPluginMethod('services.restart', { serviceType: service.type })
			expect(restarted.ok).toBe(true)
			await waitFor(() => entry(first)?.status === 'ready')
			expect(entry(first)?.port).toBe(firstPort)
			const before = serviceNotifications(host.notifications).length
			store.arm()
			let settled = false
			const shutdown = host.system.shutdown().then(() => {
				settled = true
			})
			try {
				await waitFor(() => store.blocked)
				await Bun.sleep(20)
				expect(settled).toBe(false)
				expect(serviceNotifications(host.notifications)).toHaveLength(before)
			} finally {
				store.release()
				await shutdown
			}
			for (const session of [first, second]) {
				const events = await serviceStatuses(store, session.id)
				const notifications = serviceNotifications(host.notifications).filter((n) => n.sessionId === session.id)
				expect(notifications.map((n) => n.status)).toEqual(events.map((event) => event.toStatus))
				expect(events.at(-1)?.toStatus).toBe('stopped')
			}
			for (const executor of executors) {
				expect(executor.getStatus(service.type)).toBeNull()
				expect(executor.onStatusChanged).toBeUndefined()
				expect(executor.onStartSettled).toBeUndefined()
			}
			expect(host.system.sessionManager.getRuntimeCacheStats().loadedSessionCount).toBe(0)
			expect(host.services.portPool.tryAllocate(firstPort)).toBe(true)
			expect(host.services.portPool.tryAllocate(secondPort)).toBe(true)
			host.services.portPool.release(firstPort)
			host.services.portPool.release(secondPort)
			expect(trap.calls()).toBe(0)
		})
	}

	it('releases a supplied executor restart lease after an unavailable retry and constructs a fresh executor after eviction', async () => {
		const native = createBunPlatform()
		const executors: ServiceExecutor[] = []
		const platform: Platform = {
			...native,
			createServiceExecutor(logger, pool) {
				const executor = new ServiceExecutor(logger, pool, native)
				executors.push(executor)
				return executor
			},
		}
		let available = true
		const host = await boot(
			platform,
			servicesPreset({
				...service,
				command: 'exit 1',
				availableWhen: () => available,
				restartPolicy: { maxRetries: 1, initialDelayMs: 200 },
			}),
			'isolate',
			{ sessionIdleTimeoutMs: 20 },
		)
		const session = await host.createSession()
		const started = await session.callPluginMethod('services.start', { serviceType: service.type })
		expect(started.ok).toBe(true)
		await waitFor(() => entry(session)?.status === 'failed')
		available = false
		expect(host.system.sessionManager.getRuntimeCacheStats().sessions[0]?.leaseReasons).toEqual({ 'service:preview': 1 })
		expect(executors[0]?.hasScheduledRestart(service.type)).toBe(true)
		await waitFor(() => host.system.sessionManager.getRuntimeCacheStats().loadedSessionCount === 0)
		expect(executors[0]?.onStartSettled).toBeUndefined()
		const reopened = await host.system.sessionManager.getSession(session.id)
		expect(reopened.ok).toBe(true)
		expect(executors).toHaveLength(2)
		expect(executors[1]).not.toBe(executors[0])
	})

	for (const configured of [false, true]) {
		it(`does not create an executor or call native processes for isolate sessions with ${configured ? 'empty' : 'absent'} services`, async () => {
			const trap = processTrap()
			let factoryCalls = 0
			let nativeExecutorCalls = 0
			const restore = setServiceExecutorObserverForTesting(() => {
				nativeExecutorCalls++
			})
			cleanups.push(async () => {
				restore()
			})
			const preset = createTestPreset({
				plugins: configured ? [servicePlugin.configure({ services: [], portPool: new PortPool() })] : undefined,
			})
			const platform: Platform = {
				...createBunPlatform(),
				process: trap.process,
				createServiceExecutor: configured
					? () => {
							factoryCalls++
							throw new Error('Services are disabled')
						}
					: undefined,
			}
			const host = await boot(platform, preset, 'isolate')
			const session = await host.createSession()
			expect(host.system.methodSchemas['services.start']).toBeDefined()
			expect(session.getPluginMethods().has('services.start')).toBe(false)
			await host.system.shutdown()
			expect(factoryCalls).toBe(0)
			expect(nativeExecutorCalls).toBe(0)
			expect(trap.calls()).toBe(0)
		})
	}
})
