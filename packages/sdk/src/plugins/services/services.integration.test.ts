import { afterEach, describe, expect, it } from 'bun:test'
import { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryEventStore } from '~/core/events/memory.js'
import type { DomainEvent } from '~/core/events/types.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import { selectPluginState } from '~/core/sessions/reducer.js'
import { SessionId } from '~/core/sessions/schema.js'
import { sessionEvents } from '~/core/sessions/state.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { silentLogger } from '~/lib/logger/logger.js'
import type { Dirent, FileSystem } from '~/platform/fs.js'
import type { ExecFileResult, ProcessRunner } from '~/platform/process.js'
import { createNodePlatform } from '~/testing/node-platform.js'
import { createTestPreset, TestHarness } from '~/testing/index.js'
import { serviceEvents, servicePlugin } from './plugin.js'
import type { ServiceAgentConfig, ServicePluginConfig } from './plugin.js'
import { PortPool } from './port-pool.js'
import { buildServiceStatusMessage } from './prompt.js'
import type { ServiceCommandArgs, ServiceConfig, ServiceCwdArgs, ServiceEntry, ServiceStatus } from './schema.js'
import type { ServiceStatusChangeDetails } from './service.js'
import { ServiceExecutor, setServiceExecutorObserverForTesting } from './service.js'

// ============================================================================
// Test Service Configs
// ============================================================================

const quickService: ServiceConfig = {
	type: 'quick',
	description: 'Quick service that becomes ready immediately',
	command: 'echo "service output" && sleep 60',
}

const readyPatternService: ServiceConfig = {
	type: 'ready-service',
	description: 'Service with ready pattern',
	command: 'echo "Listening READY" && sleep 60',
	readyPattern: 'READY',
}

const commandCallbackService: ServiceConfig = {
	type: 'callback-service',
	description: 'Service with command callback that uses allocated port',
	command: ({ port }) => `echo "Server on port ${port}" && sleep 60`,
	readyPattern: 'Server on port',
}

const failingService: ServiceConfig = {
	type: 'failing',
	description: 'Service that exits immediately',
	command: 'exit 1',
}

const autoStartService: ServiceConfig = {
	type: 'auto-start',
	description: 'Auto-starting service',
	command: 'sleep 60',
	autoStart: true,
}

/** Runs happily forever, but never prints what the executor is waiting for. */
const neverReadyService: ServiceConfig = {
	type: 'never-ready',
	description: 'Service whose readiness marker never arrives',
	command: 'sleep 60',
	readyPattern: 'NEVER-READY',
	startupTimeoutMs: 200,
}

// ============================================================================
// Helpers
// ============================================================================

let currentHarness: TestHarness | undefined

afterEach(async () => {
	if (currentHarness) {
		await currentHarness.shutdown()
		currentHarness = undefined
	}
})

function createServicesPreset(
	services: ServiceConfig[],
	agentServices: string[],
	portPool: PortPool,
	overrides?: Parameters<typeof createTestPreset>[0],
) {
	return createTestPreset({
		...overrides,
		plugins: [
			servicePlugin.configure({ services, portPool }),
			...(overrides?.plugins ?? []),
		],
		orchestratorPlugins: [
			servicePlugin.configureAgent({ services: agentServices }),
			...(overrides?.orchestratorPlugins ?? []),
		],
	})
}

function createServicesHarness(options: Omit<ConstructorParameters<typeof TestHarness>[0], 'systemPlugins'>) {
	const harness = new TestHarness({ ...options, systemPlugins: [servicePlugin] })
	currentHarness = harness
	return harness
}

class GatedServiceStatusEventStore extends MemoryEventStore {
	private armed = false
	private markStarted = () => {}
	private releaseAppend = () => {}
	private readonly gate = new Promise<void>((resolve) => {
		this.releaseAppend = resolve
	})
	readonly appendStarted = new Promise<void>((resolve) => {
		this.markStarted = resolve
	})
	completed = false

	arm(): void {
		this.armed = true
	}

	release(): void {
		this.releaseAppend()
	}

	override async append(sessionId: SessionId, event: DomainEvent): Promise<void> {
		if (this.armed && event.type === 'service_status_changed') {
			this.armed = false
			this.markStarted()
			await this.gate
			await super.append(sessionId, event)
			this.completed = true
			return
		}
		await super.append(sessionId, event)
	}
}

/** Wait for a service status change event of a specific type */
async function waitForServiceStatus(
	session: Awaited<ReturnType<TestHarness['createSession']>>,
	serviceType: string,
	targetStatus: string,
	timeoutMs = 5000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const events = await session.getEventsByType(serviceEvents, 'service_status_changed')
		if (events.some((e) => e.serviceType === serviceType && e.toStatus === targetStatus)) {
			return
		}
		await new Promise((r) => setTimeout(r, 50))
	}
	const seen = (await session.getEventsByType(serviceEvents, 'service_status_changed'))
		.filter((e) => e.serviceType === serviceType)
		.map((e) => e.toStatus)
	throw new Error(
		`Timed out after ${timeoutMs}ms waiting for '${serviceType}' to reach '${targetStatus}'; saw [${seen.join(', ')}]`,
	)
}

/** Wait for the services plugin state slice to reflect a given status for a serviceType */
async function waitForServiceStateStatus(
	session: Awaited<ReturnType<TestHarness['createSession']>>,
	serviceType: string,
	targetStatus: string,
	timeoutMs = 5000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const entry = selectPluginState<Map<string, ServiceEntry>>(session.state, 'services')?.get(serviceType)
		if (entry?.status === targetStatus) return
		await new Promise((r) => setTimeout(r, 20))
	}
	const actual = selectPluginState<Map<string, ServiceEntry>>(session.state, 'services')?.get(serviceType)?.status
	throw new Error(
		`Timed out after ${timeoutMs}ms waiting for '${serviceType}' state to be '${targetStatus}'; it is '${actual ?? 'absent'}'`,
	)
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

/** Wait for a process to go, and never leave a stray one behind if it does not. */
async function expectProcessGone(pid: number, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline && isProcessAlive(pid)) {
		await new Promise((r) => setTimeout(r, 50))
	}
	const alive = isProcessAlive(pid)
	if (alive) {
		try {
			process.kill(-pid, 'SIGKILL')
		} catch {
			// Already gone.
		}
	}
	expect(alive).toBe(false)
}

/**
 * Create a durable session, shut its runtime down, and spawn a detached process the
 * way a crashed runtime would have left one behind. The caller then writes the events
 * that runtime would have written about it and reopens the session.
 */
async function seedCrashedRuntime(eventStore: MemoryEventStore): Promise<{ sessionId: SessionId; orphanPid: number }> {
	const harness = new TestHarness({
		presets: [createServicesPreset([quickService], ['quick'], new PortPool())],
		llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
		systemPlugins: [servicePlugin],
		eventStore,
	})
	const sessionId = (await harness.createSession('test')).sessionId
	await harness.shutdown()

	const orphan = createNodePlatform().process.spawn('/bin/sh', ['-c', 'sleep 60'], { detached: true, stdio: 'ignore' })
	const orphanPid = orphan.pid
	if (orphanPid === undefined) throw new Error('Detached orphan did not receive a pid')
	expect(isProcessAlive(orphanPid)).toBe(true)
	return { sessionId, orphanPid }
}

/** Reopen a seeded session on a fresh runtime, which is what fires the reconcile. */
function reopenOverSameStore(eventStore: MemoryEventStore): TestHarness {
	const harness = new TestHarness({
		presets: [createServicesPreset([quickService], ['quick'], new PortPool())],
		llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
		systemPlugins: [servicePlugin],
		eventStore,
	})
	currentHarness = harness
	return harness
}

/** Wait for a condition observed directly off a ServiceExecutor, not a session. */
async function waitFor(
	condition: () => boolean,
	describeState: () => string,
	timeoutMs = 5000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (condition()) return
		await new Promise((r) => setTimeout(r, 20))
	}
	throw new Error(`Timed out after ${timeoutMs}ms; saw ${describeState()}`)
}

async function waitForAsync(condition: () => Promise<boolean>, describeState: () => string, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (await condition()) return
		await new Promise((resolve) => setTimeout(resolve, 20))
	}
	throw new Error(`Timed out after ${timeoutMs}ms; saw ${describeState()}`)
}

// ============================================================================
// Tests
// ============================================================================

describe('services plugin', () => {
	it('keeps a runtime resident while a service is still starting, and evicts it once stopped', async () => {
		const slowService: ServiceConfig = {
			type: 'slow-start',
			description: 'Never prints its ready marker',
			command: 'sleep 60',
			readyPattern: 'NEVER-PRINTED',
			startupTimeoutMs: 30_000,
		}
		const harness = createServicesHarness({
			presets: [createServicesPreset([slowService], ['slow-start'], new PortPool())],
			sessionIdleTimeoutMs: 15,
		})
		const session = await harness.createSession('test')
		const started = await session.callPluginMethod('services.start', { serviceType: 'slow-start' })
		expect(started.ok).toBe(true)
		await waitForServiceStateStatus(session, 'slow-start', 'starting')
		await Bun.sleep(50)

		// A start still in flight cannot survive disposal, so it holds the lease.
		const resident = harness.sessionManager.getRuntimeCacheStats()
		expect(resident.loadedSessionCount).toBe(1)
		expect(resident.sessions[0]?.leaseReasons).toEqual({ 'service:slow-start': 1 })

		const stopped = await session.callPluginMethod('services.stop', { serviceType: 'slow-start' })
		expect(stopped.ok).toBe(true)
		await waitFor(
			() => harness.sessionManager.getRuntimeCacheStats().loadedSessionCount === 0,
			() => JSON.stringify(harness.sessionManager.getRuntimeCacheStats()),
		)
	})

	it('evicts an idle session whose service is ready, stopping it and freeing its port', async () => {
		const portPool = new PortPool()
		const harness = createServicesHarness({
			presets: [createServicesPreset([quickService], ['quick'], portPool)],
			sessionIdleTimeoutMs: 100,
		})
		const session = await harness.createSession('test')
		const started = await session.callPluginMethod('services.start', { serviceType: 'quick', waitForReady: true })
		expect(started.ok).toBe(true)
		await waitForServiceStateStatus(session, 'quick', 'ready')
		const entry = selectPluginState<Map<string, ServiceEntry>>(session.state, 'services')?.get('quick')
		const pid = entry?.pid
		const port = entry?.port
		if (pid === undefined || port === undefined) throw new Error('Service did not report its pid and port')

		// A dev server that sits at `ready` for hours used to hold its lease for just
		// as long, which is why an idle sweep never evicted the session paying for it.
		await waitFor(
			() => harness.sessionManager.getRuntimeCacheStats().loadedSessionCount === 0,
			() => JSON.stringify(harness.sessionManager.getRuntimeCacheStats()),
		)
		expect(harness.sessionManager.getRuntimeCacheStats().evictions).toBeGreaterThanOrEqual(1)
		await waitFor(() => !isProcessAlive(pid), () => `pid ${pid} is still alive`)

		// portPool is process-global: an eviction that keeps the port loses it for the
		// life of the server, and the rebuilt runtime cannot reclaim its preview URL.
		expect(portPool.tryAllocate(port)).toBe(true)
		portPool.release(port)

		const stopEvents = (await session.getEventsByType(serviceEvents, 'service_status_changed'))
			.filter((event) => event.serviceType === 'quick' && event.toStatus === 'stopped')
		expect(stopEvents).toHaveLength(1)
		expect(stopEvents[0]?.stoppedBy).toBe('eviction')
	})

	it('a rebuilt runtime restarts a service the eviction stopped', async () => {
		const harness = createServicesHarness({
			presets: [createServicesPreset([autoStartService], ['auto-start'], new PortPool())],
			sessionIdleTimeoutMs: 100,
		})
		const session = await harness.createSession('test')
		await waitForServiceStateStatus(session, 'auto-start', 'ready')
		await waitFor(
			() => harness.sessionManager.getRuntimeCacheStats().loadedSessionCount === 0,
			() => JSON.stringify(harness.sessionManager.getRuntimeCacheStats()),
		)

		const parked = (await session.getEventsByType(serviceEvents, 'service_status_changed'))
			.filter((event) => event.serviceType === 'auto-start')
		expect(parked.at(-1)?.toStatus).toBe('stopped')
		expect(parked.at(-1)?.stoppedBy).toBe('eviction')

		await harness.openSession(session.sessionId)
		await waitForAsync(
			async () =>
				(await session.getEventsByType(serviceEvents, 'service_status_changed'))
					.filter((event) => event.serviceType === 'auto-start' && event.toStatus === 'starting').length === 2,
			() => 'waiting for the rebuilt runtime to auto-start the service again',
		)
	})

	it('a rebuilt runtime leaves a service the agent stopped alone', async () => {
		const harness = createServicesHarness({
			presets: [createServicesPreset([autoStartService], ['auto-start'], new PortPool())],
			sessionIdleTimeoutMs: 100,
		})
		const session = await harness.createSession('test')
		await waitForServiceStateStatus(session, 'auto-start', 'ready')
		const stopped = await session.callPluginMethod('services.stop', { serviceType: 'auto-start' })
		expect(stopped.ok).toBe(true)
		await waitForServiceStateStatus(session, 'auto-start', 'stopped')

		const stopEvents = (await session.getEventsByType(serviceEvents, 'service_status_changed'))
			.filter((event) => event.serviceType === 'auto-start' && event.toStatus === 'stopped')
		expect(stopEvents.at(-1)?.stoppedBy).toBe('agent')

		await waitFor(
			() => harness.sessionManager.getRuntimeCacheStats().loadedSessionCount === 0,
			() => JSON.stringify(harness.sessionManager.getRuntimeCacheStats()),
		)

		const reopened = await harness.openSession(session.sessionId)
		await Bun.sleep(300)

		const starts = (await session.getEventsByType(serviceEvents, 'service_status_changed'))
			.filter((event) => event.serviceType === 'auto-start' && event.toStatus === 'starting')
		expect(starts).toHaveLength(1)
		expect(selectPluginState<Map<string, ServiceEntry>>(reopened.state, 'services')?.get('auto-start')?.status).toBe('stopped')
	})

	it('keeps a runtime resident while an automatic restart is pending', async () => {
		const restartingService: ServiceConfig = {
			type: 'restarting',
			description: 'Fails and waits before restarting',
			command: 'exit 1',
			restartPolicy: { maxRetries: 1, initialDelayMs: 500 },
		}
		const harness = createServicesHarness({
			presets: [createServicesPreset([restartingService], ['restarting'], new PortPool())],
			sessionIdleTimeoutMs: 15,
		})
		const session = await harness.createSession('test')
		const started = await session.callPluginMethod('services.start', { serviceType: 'restarting' })
		expect(started.ok).toBe(true)
		await waitForServiceStateStatus(session, 'restarting', 'failed')
		await Bun.sleep(50)

		const resident = harness.sessionManager.getRuntimeCacheStats()
		expect(resident.loadedSessionCount).toBe(1)
		expect(resident.sessions[0]?.leaseReasons).toEqual({ 'service:restarting': 1 })

		const stopped = await session.callPluginMethod('services.stop', { serviceType: 'restarting' })
		expect(stopped.ok).toBe(true)
		await waitFor(
			() => harness.sessionManager.getRuntimeCacheStats().loadedSessionCount === 0,
			() => JSON.stringify(harness.sessionManager.getRuntimeCacheStats()),
		)
	})

	it('releases a restart lease when the deferred start becomes unavailable', async () => {
		let available = true
		const restartingService: ServiceConfig = {
			type: 'conditional-restart',
			description: 'Becomes unavailable before its deferred restart',
			command: 'exit 1',
			availableWhen: () => available,
			restartPolicy: { maxRetries: 1, initialDelayMs: 100 },
		}
		const harness = createServicesHarness({
			presets: [createServicesPreset([restartingService], ['conditional-restart'], new PortPool())],
			sessionIdleTimeoutMs: 20,
		})
		const session = await harness.createSession('test')
		const started = await session.callPluginMethod('services.start', { serviceType: 'conditional-restart' })
		expect(started.ok).toBe(true)
		await waitForServiceStateStatus(session, 'conditional-restart', 'failed')
		available = false

		await waitFor(
			() => harness.sessionManager.getRuntimeCacheStats().sessions[0]?.activeLeaseCount === 0,
			() => JSON.stringify(harness.sessionManager.getRuntimeCacheStats()),
		)
		await waitFor(
			() => harness.sessionManager.getRuntimeCacheStats().loadedSessionCount === 0,
			() => JSON.stringify(harness.sessionManager.getRuntimeCacheStats()),
		)
	})

	it('drains a pending status append before explicit disposal completes', async () => {
		const eventStore = new GatedServiceStatusEventStore()
		const harness = createServicesHarness({
			presets: [createServicesPreset([quickService], ['quick'], new PortPool())],
			eventStore,
		})
		const session = await harness.createSession('test')
		const started = await session.callPluginMethod('services.start', { serviceType: 'quick', waitForReady: true })
		expect(started.ok).toBe(true)
		eventStore.arm()

		let closeSettled = false
		const close = session.close().then(() => {
			closeSettled = true
		})
		try {
			await eventStore.appendStarted
			await Bun.sleep(10)

			expect(closeSettled).toBe(false)
			expect(eventStore.completed).toBe(false)
		} finally {
			eventStore.release()
		}
		await close
		expect(eventStore.completed).toBe(true)
		expect(harness.sessionManager.getRuntimeCacheStats().loadedSessionCount).toBe(0)
	})

	it('disables late status publication when executor close rejects', async () => {
		let executor: ServiceExecutor | undefined
		const restoreObserver = setServiceExecutorObserverForTesting((created) => {
			executor = created
		})
		const harness = createServicesHarness({
			presets: [createServicesPreset([quickService], ['quick'], new PortPool())],
		})
		const session = await harness.createSession('test')
		const started = await session.callPluginMethod('services.start', { serviceType: 'quick', waitForReady: true })
		expect(started.ok).toBe(true)
		if (!executor) throw new Error('Expected observed service executor')
		const observedExecutor = executor
		const originalClose = observedExecutor.close.bind(observedExecutor)
		const lateStatusCallback = observedExecutor.onStatusChanged
		observedExecutor.close = async () => {
			throw new Error('Controlled termination failure')
		}

		try {
			await session.close()
			const statusCount = (await session.getEventsByType(serviceEvents, 'service_status_changed')).length
			const notificationCount = session.getNotifications().filter((notification) => notification.type === 'serviceStatus').length

			expect(observedExecutor.onStatusChanged).toBeUndefined()
			lateStatusCallback?.(String(session.sessionId), 'quick', 'failed', { error: 'late failure' })
			await Bun.sleep(10)

			expect((await session.getEventsByType(serviceEvents, 'service_status_changed')).length).toBe(statusCount)
			expect(session.getNotifications().filter((notification) => notification.type === 'serviceStatus')).toHaveLength(notificationCount)
			expect(harness.sessionManager.getRuntimeCacheStats().loadedSessionCount).toBe(0)
		} finally {
			await originalClose(session.sessionId)
			restoreObserver()
		}
	})

	// =========================================================================
	// Service lifecycle via methods
	// =========================================================================

	describe('service lifecycle via methods', () => {
		it('start → status_changed events (starting, ready) → state updated', async () => {
			const portPool = new PortPool()
			const harness = createServicesHarness({
				presets: [createServicesPreset([quickService], ['quick'], portPool)],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			const entryAgentId = session.getEntryAgentId()!
			const result = await session.callPluginMethod('services.start', {
				sessionId: String(session.sessionId),
				agentId: String(entryAgentId),
				serviceType: 'quick',
			})
			expect(result.ok).toBe(true)

			// Wait for ready (no readyPattern = immediately ready)
			await waitForServiceStatus(session, 'quick', 'ready')

			const events = await session.getEventsByType(serviceEvents, 'service_status_changed')
			const quickEvents = events.filter((e) => e.serviceType === 'quick')
			const statuses = quickEvents.map((e) => e.toStatus)
			expect(statuses).toContain('starting')
			expect(statuses).toContain('ready')

			// Verify state has port from pool
			const serviceState = selectPluginState<Map<string, ServiceEntry>>(session.state, 'services')?.get('quick')
			expect(serviceState).toBeDefined()
			expect(serviceState!.status).toBe('ready')
			expect(serviceState!.port).toBeGreaterThanOrEqual(10000)
			expect(serviceState!.port).toBeLessThanOrEqual(49151)
		})

		it('stop running service → status stopped', async () => {
			const portPool = new PortPool()
			const harness = createServicesHarness({
				presets: [createServicesPreset([quickService], ['quick'], portPool)],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			const entryAgentId = session.getEntryAgentId()!
			await session.callPluginMethod('services.start', {
				sessionId: String(session.sessionId),
				agentId: String(entryAgentId),
				serviceType: 'quick',
			})
			await waitForServiceStatus(session, 'quick', 'ready')

			const stopResult = await session.callPluginMethod('services.stop', {
				sessionId: String(session.sessionId),
				agentId: String(entryAgentId),
				serviceType: 'quick',
			})
			expect(stopResult.ok).toBe(true)

			await waitForServiceStatus(session, 'quick', 'stopped')

			const serviceState = selectPluginState<Map<string, ServiceEntry>>(session.state, 'services')?.get('quick')
			expect(serviceState!.status).toBe('stopped')
		})

		it('start already running service → idempotent', async () => {
			const portPool = new PortPool()
			const harness = createServicesHarness({
				presets: [createServicesPreset([quickService], ['quick'], portPool)],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			const entryAgentId = session.getEntryAgentId()!
			await session.callPluginMethod('services.start', {
				sessionId: String(session.sessionId),
				agentId: String(entryAgentId),
				serviceType: 'quick',
			})
			await waitForServiceStatus(session, 'quick', 'ready')

			// Start again — should be idempotent
			const result = await session.callPluginMethod('services.start', {
				sessionId: String(session.sessionId),
				agentId: String(entryAgentId),
				serviceType: 'quick',
			})
			expect(result.ok).toBe(true)
		})
	})

	// =========================================================================
	// Port pool allocation
	// =========================================================================

	describe('port pool allocation', () => {
		it('starting event includes allocated port', async () => {
			const portPool = new PortPool()
			const harness = createServicesHarness({
				presets: [createServicesPreset([quickService], ['quick'], portPool)],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			const entryAgentId = session.getEntryAgentId()!
			await session.callPluginMethod('services.start', {
				sessionId: String(session.sessionId),
				agentId: String(entryAgentId),
				serviceType: 'quick',
			})
			await waitForServiceStatus(session, 'quick', 'ready')

			const events = await session.getEventsByType(serviceEvents, 'service_status_changed')
			const startingEvent = events.find((e) => e.serviceType === 'quick' && e.toStatus === 'starting')
			expect(startingEvent).toBeDefined()
			expect(startingEvent!.port).toBeGreaterThanOrEqual(10000)
		})

		it('command callback receives allocated port', async () => {
			const portPool = new PortPool()
			const harness = createServicesHarness({
				presets: [createServicesPreset([commandCallbackService], ['callback-service'], portPool)],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			const entryAgentId = session.getEntryAgentId()!
			await session.callPluginMethod('services.start', {
				sessionId: String(session.sessionId),
				agentId: String(entryAgentId),
				serviceType: 'callback-service',
			})
			await waitForServiceStatus(session, 'callback-service', 'ready')

			// Port should be in state from starting event
			const serviceState = selectPluginState<Map<string, ServiceEntry>>(session.state, 'services')?.get('callback-service')
			expect(serviceState!.port).toBeGreaterThanOrEqual(10000)
		})

		it('resolves cwd, command, and env callbacks with runtime context', async () => {
			const workspaceDir = await mkdtemp(join(tmpdir(), 'roj-svc-runtime-'))
			const webDir = join(workspaceDir, 'packages', 'web')
			await mkdir(webDir, { recursive: true })

			let cwdArgs: ServiceCwdArgs | undefined
			let commandArgs: ServiceCommandArgs | undefined
			let envArgs: ServiceCommandArgs | undefined

			const runtimeService: ServiceConfig = {
				type: 'runtime',
				description: 'Service with runtime resolvers',
				cwd: (args) => {
					cwdArgs = args
					return 'packages/web'
				},
				command: async (args) => {
					commandArgs = args
					return `printf "%s" "$RUNTIME_MARKER" > marker.txt && echo "READY ${args.port}" && sleep 60`
				},
				env: (args) => {
					envArgs = args
					return {
						RUNTIME_MARKER: `${args.sessionId}|${args.workspaceDir}|${args.cwd}|${args.port}`,
					}
				},
				readyPattern: 'READY',
			}

			try {
				const portPool = new PortPool()
				const harness = createServicesHarness({
					presets: [createServicesPreset([runtimeService], ['runtime'], portPool, { workspaceDir })],
					llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
				})

				const session = await harness.createSession('test')
				const entryAgentId = session.getEntryAgentId()!
				const startResult = await session.callPluginMethod('services.start', {
					sessionId: String(session.sessionId),
					agentId: String(entryAgentId),
					serviceType: 'runtime',
				})
				expect(startResult.ok).toBe(true)
				await waitForServiceStatus(session, 'runtime', 'ready')

				const serviceState = selectPluginState<Map<string, ServiceEntry>>(session.state, 'services')?.get('runtime')
				expect(cwdArgs?.workspaceDir).toBe(workspaceDir)
				expect(cwdArgs?.sessionId).toBe(String(session.sessionId))
				expect(commandArgs?.cwd).toBe(webDir)
				expect(commandArgs?.workspaceDir).toBe(workspaceDir)
				expect(envArgs?.cwd).toBe(webDir)
				expect(serviceState?.cwd).toBe(webDir)
				expect(serviceState?.command).toContain('RUNTIME_MARKER')

				const marker = await readFile(join(webDir, 'marker.txt'), 'utf-8')
				expect(marker).toContain(String(session.sessionId))
				expect(marker).toContain(workspaceDir)
				expect(marker).toContain(webDir)

				const statusResult = await session.callPluginMethod('services.status', {
					sessionId: String(session.sessionId),
					agentId: String(entryAgentId),
					serviceType: 'runtime',
				})
				expect(statusResult).toMatchObject({
					ok: true,
					value: {
						status: 'ready',
						cwd: webDir,
						command: serviceState?.command,
					},
				})
			} finally {
				await rm(workspaceDir, { recursive: true, force: true })
			}
		})
	})

	// =========================================================================
	// Service tools
	// =========================================================================

	describe('service tools', () => {
		it('agent calls service_start tool → service starts', async () => {
			const portPool = new PortPool()
			const harness = createServicesHarness({
				presets: [createServicesPreset([quickService], ['quick'], portPool)],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'service_start',
							input: { serviceType: 'quick' },
						}],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Start service')

			await waitForServiceStatus(session, 'quick', 'ready')

			const events = await session.getEventsByType(serviceEvents, 'service_status_changed')
			const quickEvents = events.filter((e) => e.serviceType === 'quick')
			expect(quickEvents.map((e) => e.toStatus)).toContain('ready')
		})

		it('agent calls service_status → returns status info', async () => {
			const portPool = new PortPool()
			const harness = createServicesHarness({
				presets: [createServicesPreset([quickService], ['quick'], portPool)],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			const entryAgentId = session.getEntryAgentId()!

			// Start service
			await session.callPluginMethod('services.start', {
				sessionId: String(session.sessionId),
				agentId: String(entryAgentId),
				serviceType: 'quick',
			})
			await waitForServiceStatus(session, 'quick', 'ready')

			// Get status
			const statusResult = await session.callPluginMethod('services.status', {
				sessionId: String(session.sessionId),
				agentId: String(entryAgentId),
				serviceType: 'quick',
			})
			expect(statusResult).toMatchObject({ ok: true, value: { status: 'ready' } })
		})

		it('service not in agent visible list → error', async () => {
			const portPool = new PortPool()
			const harness = createServicesHarness({
				presets: [createServicesPreset([quickService], [], portPool)], // empty visible list
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			// No service tools should be available
			const lastRequest = harness.llmProvider.getLastRequest()
			const toolNames = lastRequest?.tools?.map((t) => t.name) ?? []
			expect(toolNames).not.toContain('service_start')
			expect(toolNames).not.toContain('service_stop')
		})
	})

	// =========================================================================
	// Auto-start on session ready
	// =========================================================================

	describe('auto-start on session ready', () => {
		it('service with autoStart: true → started on session creation', async () => {
			const portPool = new PortPool()
			const harness = createServicesHarness({
				presets: [createServicesPreset([autoStartService], ['auto-start'], portPool)],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			// Session creation triggers onSessionReady → autoStart services

			await waitForServiceStatus(session, 'auto-start', 'ready')

			const events = await session.getEventsByType(serviceEvents, 'service_status_changed')
			const autoEvents = events.filter((e) => e.serviceType === 'auto-start')
			expect(autoEvents.map((e) => e.toStatus)).toContain('ready')
		})

		it('availableWhen false skips auto-start and explicit start returns an error', async () => {
			const unavailableService: ServiceConfig = {
				type: 'unavailable',
				description: 'Unavailable service',
				command: 'sleep 60',
				autoStart: true,
				availableWhen: () => false,
			}
			const portPool = new PortPool()
			const harness = createServicesHarness({
				presets: [createServicesPreset([unavailableService], ['unavailable'], portPool)],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await new Promise((resolve) => setTimeout(resolve, 100))

			const events = await session.getEventsByType(serviceEvents, 'service_status_changed')
			expect(events.some((event) => event.serviceType === 'unavailable')).toBe(false)

			const entryAgentId = session.getEntryAgentId()!
			const result = await session.callPluginMethod('services.start', {
				sessionId: String(session.sessionId),
				agentId: String(entryAgentId),
				serviceType: 'unavailable',
			})
			expect(result.ok).toBe(false)
		})
	})

	// =========================================================================
	// Service failure
	// =========================================================================

	describe('service failure', () => {
		it('service that exits immediately → status failed with error', async () => {
			const portPool = new PortPool()
			const harness = createServicesHarness({
				presets: [createServicesPreset([failingService], ['failing'], portPool)],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			const entryAgentId = session.getEntryAgentId()!
			await session.callPluginMethod('services.start', {
				sessionId: String(session.sessionId),
				agentId: String(entryAgentId),
				serviceType: 'failing',
			})

			await waitForServiceStatus(session, 'failing', 'failed')

			const events = await session.getEventsByType(serviceEvents, 'service_status_changed')
			const failEvent = events.find((e) => e.serviceType === 'failing' && e.toStatus === 'failed')
			expect(failEvent).toBeDefined()
			expect(failEvent!.error).toBeDefined()
		})

		it('a service that closes during spawn setup skips ready and schedules restart', async () => {
			const child = new ChildProcess()
			const stdout = new EventEmitter()
			Object.defineProperties(child, {
				pid: { value: 424_242 },
				stdin: { value: null },
				stdout: { value: stdout },
				stderr: { value: null },
			})
			const processRunner: ProcessRunner = {
				spawn: () => {
					// The death lands in the window between spawn and the handlers —
					// the case a runtime never replays. exitCode is deliberately left
					// unset so only the event can reveal it.
					queueMicrotask(() => {
						stdout.emit('data', Buffer.from('READY\n'))
						child.emit('close', 1)
					})
					return child
				},
				execFile: async (): Promise<ExecFileResult> => {
					throw new Error('Unexpected execFile call')
				},
			}
			const platform = createNodePlatform()
			const executor = new ServiceExecutor(silentLogger, new PortPool(), {
				fs: platform.fs,
				process: processRunner,
			})
			const observed: Array<{ status: ServiceStatus; details: ServiceStatusChangeDetails }> = []
			executor.onStatusChanged = (_sessionId, _serviceType, status, details) => {
				observed.push({ status, details })
			}

			try {
				const result = await executor.start({
					type: 'missed-close',
					description: 'Process is already gone when spawn returns',
					command: 'unused',
					readyPattern: 'READY',
					restartPolicy: { maxRetries: 1, initialDelayMs: 60_000 },
				}, SessionId('s-missed-close'))

				expect(result.ok).toBe(true)
				expect(observed.map(({ status }) => status)).toEqual(['starting', 'failed'])
				expect(observed.filter(({ status }) => status === 'failed')).toHaveLength(1)
				const failure = observed.find(({ status }) => status === 'failed')
				expect(failure?.details.restartAttempt).toBe(1)
				expect(failure?.details.restartMaxRetries).toBe(1)
				expect(failure?.details.restartAt).toBeGreaterThan(Date.now())
			} finally {
				await executor.close(SessionId('s-missed-close'))
			}
		})

		it('bounds output produced during spawn setup while preserving its diagnostic tail', async () => {
			const child = new ChildProcess()
			// Bare emitters, not streams: a real child's pipe drops what it emitted
			// before anything listened, and a buffering stream would hide exactly the
			// loss this test is about.
			const stderr = new EventEmitter()
			Object.defineProperties(child, {
				pid: { value: 424_243 },
				stdin: { value: null },
				stdout: { value: new EventEmitter() },
				stderr: { value: stderr },
			})
			const processRunner: ProcessRunner = {
				spawn: () => {
					queueMicrotask(() => {
						stderr.emit('data', Buffer.from('line-0\nline-1\nline-2\nline-3\nline-4\n'))
						stderr.emit('data', Buffer.concat([Buffer.alloc(100_000, 'x'), Buffer.from('\n')]))
						child.emit('close', 7)
					})
					return child
				},
				execFile: async (): Promise<ExecFileResult> => {
					throw new Error('Unexpected execFile call')
				},
			}
			const platform = createNodePlatform()
			const executor = new ServiceExecutor(silentLogger, new PortPool(), {
				fs: platform.fs,
				process: processRunner,
			})
			const observed: ServiceStatus[] = []
			executor.onStatusChanged = (_sessionId, _serviceType, status) => {
				observed.push(status)
			}

			try {
				await executor.start({
					type: 'loud-crash',
					description: 'Explains itself on stderr, then exits',
					command: 'unused',
					logBufferSize: 3,
				}, SessionId('s-loud-crash'))

				await waitFor(() => observed.includes('failed'), () => `[${observed.join(', ')}]`)

				const logs = executor.getLogs('loud-crash')
				expect(logs.ok).toBe(true)
				if (logs.ok) {
					expect(logs.value).toHaveLength(3)
					expect(logs.value[0]).toBe('[stderr] line-3')
					expect(logs.value[1]).toBe('[stderr] line-4')
					expect(logs.value[2]?.startsWith('[stderr] xxx')).toBe(true)
					expect(logs.value[2]?.length).toBe(16_384)
				}
			} finally {
				await executor.close(SessionId('s-loud-crash'))
			}
		})

		it('does not mark an already-reaped child ready before close drains its output', async () => {
			const child = new ChildProcess()
			Object.defineProperties(child, {
				pid: { value: 424_244 },
				exitCode: { value: 9 },
				stdin: { value: null },
				stdout: { value: new EventEmitter() },
				stderr: { value: new EventEmitter() },
			})
			const processRunner: ProcessRunner = {
				spawn: () => child,
				execFile: async (): Promise<ExecFileResult> => {
					throw new Error('Unexpected execFile call')
				},
			}
			const platform = createNodePlatform()
			const executor = new ServiceExecutor(silentLogger, new PortPool(), {
				fs: platform.fs,
				process: processRunner,
			})
			const observed: ServiceStatus[] = []
			executor.onStatusChanged = (_sessionId, _serviceType, status) => observed.push(status)

			try {
				const result = await executor.start({
					type: 'already-reaped',
					description: 'Exit is recorded before stdio closes',
					command: 'unused',
				}, SessionId('s-already-reaped'))

				expect(result.ok).toBe(true)
				expect(observed).toEqual(['starting'])
				child.emit('close', 9)
				await waitFor(() => observed.includes('failed'), () => `[${observed.join(', ')}]`)
				expect(observed).toEqual(['starting', 'failed'])
			} finally {
				await executor.close(SessionId('s-already-reaped'))
			}
		})

		it('detects a setup ready marker before truncating an oversized partial line', async () => {
			const child = new ChildProcess()
			const stdout = new EventEmitter()
			Object.defineProperties(child, {
				pid: { value: 424_245 },
				stdin: { value: null },
				stdout: { value: stdout },
				stderr: { value: new EventEmitter() },
			})
			const processRunner: ProcessRunner = {
				spawn: () => child,
				execFile: async (): Promise<ExecFileResult> => {
					throw new Error('Unexpected execFile call')
				},
			}
			const recordStarted = Promise.withResolvers<void>()
			const releaseRecord = Promise.withResolvers<void>()
			const platform = createNodePlatform()
			const executor = new ServiceExecutor(silentLogger, new PortPool(), {
				fs: platform.fs,
				process: processRunner,
				pidRegistry: {
					record: async () => {
						recordStarted.resolve()
						await releaseRecord.promise
					},
					forget: async () => {},
				},
			})

			try {
				const started = executor.start({
					type: 'ready-before-truncation',
					description: 'Ready marker precedes an oversized diagnostic tail',
					command: 'unused',
					readyPattern: 'READY',
					logBufferSize: 1,
				}, SessionId('s-ready-before-truncation'))
				await recordStarted.promise
				stdout.emit('data', Buffer.concat([Buffer.from('READY'), Buffer.alloc(100_000, 'x')]))
				releaseRecord.resolve()
				expect((await started).ok).toBe(true)
				expect(executor.getStatus('ready-before-truncation')).toBe('ready')

				child.emit('close', 1)
				await waitFor(() => executor.getStatus('ready-before-truncation') === 'failed', () => String(executor.getStatus('ready-before-truncation')))
			} finally {
				releaseRecord.resolve()
				await executor.close(SessionId('s-ready-before-truncation'))
			}
		})

		it('keeps completed stdout and stderr diagnostics in emission order', async () => {
			const child = new ChildProcess()
			const stdout = new EventEmitter()
			const stderr = new EventEmitter()
			Object.defineProperties(child, {
				pid: { value: 424_246 },
				stdin: { value: null },
				stdout: { value: stdout },
				stderr: { value: stderr },
			})
			const processRunner: ProcessRunner = {
				spawn: () => {
					queueMicrotask(() => {
						stdout.emit('data', Buffer.from('out-'))
						stderr.emit('data', Buffer.from('err\n'))
						stdout.emit('data', Buffer.from('done\n'))
						child.emit('close', 1)
					})
					return child
				},
				execFile: async (): Promise<ExecFileResult> => {
					throw new Error('Unexpected execFile call')
				},
			}
			const platform = createNodePlatform()
			const executor = new ServiceExecutor(silentLogger, new PortPool(), { fs: platform.fs, process: processRunner })

			try {
				await executor.start({
					type: 'interleaved-output',
					description: 'Interleaved stream output',
					command: 'unused',
				}, SessionId('s-interleaved-output'))
				await waitFor(() => executor.getStatus('interleaved-output') === 'failed', () => String(executor.getStatus('interleaved-output')))
				const logs = executor.getLogs('interleaved-output')
				expect(logs.ok).toBe(true)
				if (logs.ok) expect(logs.value).toEqual(['[stderr] err', 'out-done'])
			} finally {
				await executor.close(SessionId('s-interleaved-output'))
			}
		})

		it('flushes unterminated stdout and stderr diagnostics in callback order', async () => {
			const child = new ChildProcess()
			const stdout = new EventEmitter()
			const stderr = new EventEmitter()
			Object.defineProperties(child, {
				pid: { value: 424_247 },
				stdin: { value: null },
				stdout: { value: stdout },
				stderr: { value: stderr },
			})
			const processRunner: ProcessRunner = {
				spawn: () => {
					queueMicrotask(() => {
						stderr.emit('data', Buffer.from('stderr-partial'))
						stdout.emit('data', Buffer.from('stdout-partial'))
						child.emit('close', 1)
					})
					return child
				},
				execFile: async (): Promise<ExecFileResult> => {
					throw new Error('Unexpected execFile call')
				},
			}
			const platform = createNodePlatform()
			const executor = new ServiceExecutor(silentLogger, new PortPool(), { fs: platform.fs, process: processRunner })

			try {
				await executor.start({
					type: 'partial-output-order',
					description: 'Unterminated interleaved stream output',
					command: 'unused',
				}, SessionId('s-partial-output-order'))
				await waitFor(() => executor.getStatus('partial-output-order') === 'failed', () => String(executor.getStatus('partial-output-order')))
				const logs = executor.getLogs('partial-output-order')
				expect(logs.ok).toBe(true)
				if (logs.ok) expect(logs.value).toEqual(['[stderr] stderr-partial', 'stdout-partial'])
			} finally {
				await executor.close(SessionId('s-partial-output-order'))
			}
		})
	})

	// =========================================================================
	// Ready pattern
	// =========================================================================

	describe('ready pattern', () => {
		it('service with readyPattern → status ready when pattern matches', async () => {
			const portPool = new PortPool()
			const harness = createServicesHarness({
				presets: [createServicesPreset([readyPatternService], ['ready-service'], portPool)],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			const entryAgentId = session.getEntryAgentId()!
			await session.callPluginMethod('services.start', {
				sessionId: String(session.sessionId),
				agentId: String(entryAgentId),
				serviceType: 'ready-service',
			})

			await waitForServiceStatus(session, 'ready-service', 'ready')

			const serviceState = selectPluginState<Map<string, ServiceEntry>>(session.state, 'services')?.get('ready-service')
			expect(serviceState!.status).toBe('ready')
		})

		it('readyWhen can mark a service ready without output pattern', async () => {
			let checks = 0
			const readyWhenService: ServiceConfig = {
				type: 'ready-when',
				description: 'Service with callback readiness',
				command: 'sleep 60',
				readyWhen: () => {
					checks += 1
					return checks > 1
				},
				readyCheckIntervalMs: 20,
				startupTimeoutMs: 1000,
			}
			const portPool = new PortPool()
			const harness = createServicesHarness({
				presets: [createServicesPreset([readyWhenService], ['ready-when'], portPool)],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			const entryAgentId = session.getEntryAgentId()!
			const result = await session.callPluginMethod('services.start', {
				sessionId: String(session.sessionId),
				agentId: String(entryAgentId),
				serviceType: 'ready-when',
			})
			expect(result.ok).toBe(true)

			await waitForServiceStatus(session, 'ready-when', 'ready')
			expect(checks).toBeGreaterThan(1)
		})
	})

	// =========================================================================
	// Server restart reconcile
	// =========================================================================

	describe('onSessionReady reconcile after server restart', () => {
		it('preserves port in state when service transitions to stopped', async () => {
			const portPool = new PortPool()
			const harness = createServicesHarness({
				presets: [createServicesPreset([quickService], ['quick'], portPool)],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			const entryAgentId = session.getEntryAgentId()!
			await session.callPluginMethod('services.start', {
				sessionId: String(session.sessionId),
				agentId: String(entryAgentId),
				serviceType: 'quick',
			})
			await waitForServiceStateStatus(session, 'quick', 'ready')

			const portBefore = selectPluginState<Map<string, ServiceEntry>>(session.state, 'services')?.get('quick')?.port
			expect(portBefore).toBeDefined()

			await session.callPluginMethod('services.stop', {
				sessionId: String(session.sessionId),
				agentId: String(entryAgentId),
				serviceType: 'quick',
			})
			await waitForServiceStateStatus(session, 'quick', 'stopped')

			const stopped = selectPluginState<Map<string, ServiceEntry>>(session.state, 'services')?.get('quick')
			expect(stopped?.status).toBe('stopped')
			expect(stopped?.port).toBe(portBefore!)
			expect(stopped?.pid).toBeUndefined()
		})

		it('kills orphaned process group from previous server instance', async () => {
			const eventStore = new MemoryEventStore()
			const platform = createNodePlatform()

			// Create the durable session first, then inject the process record that a
			// crashed runtime would leave behind without calling lifecycle hooks.
			const harness1 = new TestHarness({
				presets: [createServicesPreset([quickService], ['quick'], new PortPool())],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
				systemPlugins: [servicePlugin],
				eventStore,
			})

			const session1 = await harness1.createSession('test')
			const sessionId = session1.sessionId
			await harness1.shutdown()

			const orphan = platform.process.spawn('/bin/sh', ['-c', 'sleep 60'], {
				detached: true,
				stdio: 'ignore',
			})
			const orphanPid = orphan.pid
			const orphanPort = 41_234
			expect(orphanPid).toBeDefined()
			if (orphanPid === undefined) throw new Error('Detached orphan did not receive a pid')
			await eventStore.append(sessionId, {
				...serviceEvents.create('service_status_changed', {
					serviceType: 'quick',
					toStatus: 'starting',
					port: orphanPort,
					pid: orphanPid,
				}),
				sessionId,
			})
			expect(() => process.kill(orphanPid, 0)).not.toThrow()

			// Harness 2: fresh SessionManager over the same event store
			const harness2 = new TestHarness({
				presets: [createServicesPreset([quickService], ['quick'], new PortPool())],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
				systemPlugins: [servicePlugin],
				eventStore,
			})
			currentHarness = harness2

			// Opening the session fires onSessionReady → reconcile kills the orphan
			const session2 = await harness2.openSession(sessionId)

			await waitForServiceStateStatus(session2, 'quick', 'stopped', 3000)

			// Give the OS a beat to reap the killed process
			for (let i = 0; i < 20; i++) {
				try {
					process.kill(orphanPid, 0)
				} catch {
					break
				}
				await new Promise((r) => setTimeout(r, 50))
			}

			let isAlive = true
			try {
				process.kill(orphanPid, 0)
			} catch {
				isAlive = false
			}
			// Safety net in case reconcile didn't kill it — don't leave zombies behind
			if (isAlive) {
				try {
					process.kill(-orphanPid, 'SIGKILL')
				} catch {
					// already gone
				}
			}
			expect(isAlive).toBe(false)

			// Port preserved in state — next start() would receive it via preferredPort
			const stateAfter = selectPluginState<Map<string, ServiceEntry>>(session2.state, 'services')?.get('quick')
			expect(stateAfter?.status).toBe('stopped')
			expect(stateAfter?.port).toBe(orphanPort)
			expect(stateAfter?.pid).toBeUndefined()
		})

		it('reclaims a failed entry a previous runtime left owning a process', async () => {
			const eventStore = new MemoryEventStore()
			const { sessionId, orphanPid } = await seedCrashedRuntime(eventStore)
			const orphanPort = 41_235

			// The shape production leaves behind: the wait gave up, the process did not.
			for (const event of [
				serviceEvents.create('service_status_changed', {
					serviceType: 'quick',
					toStatus: 'starting',
					port: orphanPort,
					pid: orphanPid,
				}),
				serviceEvents.create('service_status_changed', {
					serviceType: 'quick',
					toStatus: 'failed',
					port: orphanPort,
					pid: orphanPid,
					error: 'Service startup timed out after 30000ms',
				}),
			]) {
				await eventStore.append(sessionId, { ...event, sessionId })
			}

			const session = await reopenOverSameStore(eventStore).openSession(sessionId)
			await waitFor(
				() => selectPluginState<Map<string, ServiceEntry>>(session.state, 'services')?.get('quick')?.pid === undefined,
				() => `pid ${selectPluginState<Map<string, ServiceEntry>>(session.state, 'services')?.get('quick')?.pid}`,
				3000,
			)
			await expectProcessGone(orphanPid)

			// Only the claim on the process is taken away — the failure still has to be
			// legible to the agent and to the SPA.
			const entry = selectPluginState<Map<string, ServiceEntry>>(session.state, 'services')?.get('quick')
			expect(entry?.status).toBe('failed')
			expect(entry?.error).toBe('Service startup timed out after 30000ms')
			expect(entry?.port).toBe(orphanPort)
		})

		it('reclaims an orphan that session_restarted had already marked stopped', async () => {
			const eventStore = new MemoryEventStore()
			const { sessionId, orphanPid } = await seedCrashedRuntime(eventStore)
			const orphanPort = 41_236

			// A runtime that dies mid-run recovers through session_restarted, which lands
			// before onSessionReady. It settles the service without killing anything, so
			// the pid it records is the only handle the reconcile has left.
			for (const event of [
				serviceEvents.create('service_status_changed', {
					serviceType: 'quick',
					toStatus: 'starting',
					port: orphanPort,
					pid: orphanPid,
				}),
				sessionEvents.create('session_restarted', { resetAgentIds: [], clearedToolAgentIds: [] }),
			]) {
				await eventStore.append(sessionId, { ...event, sessionId })
			}

			const session = await reopenOverSameStore(eventStore).openSession(sessionId)
			await waitForServiceStateStatus(session, 'quick', 'stopped', 3000)
			await expectProcessGone(orphanPid)

			const entry = selectPluginState<Map<string, ServiceEntry>>(session.state, 'services')?.get('quick')
			expect(entry?.pid).toBeUndefined()
			// Nobody decided to stop it, so autoStart is still allowed to bring it back.
			expect(entry?.stoppedBy).toBe('eviction')
		})

		it('refuses to reclaim an orphan whose pid the kernel has recycled', async () => {
			const eventStore = new MemoryEventStore()
			const { sessionId, orphanPid } = await seedCrashedRuntime(eventStore)

			await eventStore.append(sessionId, {
				...serviceEvents.create('service_status_changed', {
					serviceType: 'quick',
					toStatus: 'starting',
					port: 41_237,
					pid: orphanPid,
					// Recorded against a process that has since died and handed its pid on.
					pidStartTime: 1,
				}),
				sessionId,
			})

			const session = await reopenOverSameStore(eventStore).openSession(sessionId)
			await waitForServiceStateStatus(session, 'quick', 'stopped', 3000)

			// The pid is somebody else's now, so it is not ours to kill — but the claim
			// still goes, or every later boot would examine it again.
			expect(isProcessAlive(orphanPid)).toBe(true)
			expect(selectPluginState<Map<string, ServiceEntry>>(session.state, 'services')?.get('quick')?.pid).toBeUndefined()
			process.kill(-orphanPid, 'SIGKILL')
		})
	})

	describe('reclaiming a failed service', () => {
		const systemError = (code: string): Error => {
			const error = new Error(code)
			Object.defineProperty(error, 'code', { value: code })
			return error
		}

		/**
		 * Drive a real service to `failed` while its process is still running — the
		 * production shape this whole area exists for. The startup timeout's reap is made
		 * to fail so the verdict lands on the wait without anything dying; flipping
		 * `killsLand` afterwards hands the executor a working kill again.
		 */
		const startFailedButAlive = async (sessionId: SessionId) => {
			const platform = createNodePlatform()
			const seam = { killsLand: false }
			const executor = new ServiceExecutor(silentLogger, new PortPool(), {
				fs: platform.fs,
				process: platform.process,
				kill: (pid, signal) => {
					if (!seam.killsLand && signal === 'SIGKILL') throw systemError('EPERM')
					return process.kill(pid, signal)
				},
			})
			// One entry per spawn — a `failed` change republishes the same pid on purpose.
			const pids: number[] = []
			executor.onStatusChanged = (_sessionId, _serviceType, status, details) => {
				if (status === 'starting' && details.pid !== undefined) pids.push(details.pid)
			}

			const started = await executor.start(neverReadyService, sessionId)
			expect(started.ok).toBe(true)
			await waitFor(
				() => executor.getStatus('never-ready') === 'failed',
				() => `status ${executor.getStatus('never-ready')}`,
			)
			expect(pids).toHaveLength(1)
			expect(isProcessAlive(pids[0]!)).toBe(true)

			return { executor, seam, pids, failedPid: pids[0]! }
		}

		it('stopping a failed service reclaims its process group and settles it', async () => {
			const sessionId = SessionId('s-stop-failed')
			const { executor, seam, failedPid } = await startFailedButAlive(sessionId)

			try {
				seam.killsLand = true
				const stopped = await executor.stop('never-ready', sessionId)

				expect(stopped.ok).toBe(true)
				expect(executor.getStatus('never-ready')).toBe('stopped')
				await expectProcessGone(failedPid)
			} finally {
				await executor.close(sessionId).catch(() => {})
			}
		})

		it('starting over a failed entry reclaims the process it still owns', async () => {
			const sessionId = SessionId('s-supersede-failed')
			const { executor, seam, pids, failedPid } = await startFailedButAlive(sessionId)

			try {
				seam.killsLand = true
				// A restart reuses the port on purpose, so the abandoned generation has to go
				// before the replacement spawns rather than being merely forgotten.
				const restarted = await executor.start(neverReadyService, sessionId)

				expect(restarted.ok).toBe(true)
				await expectProcessGone(failedPid)
				expect(pids).toHaveLength(2)
				expect(pids[1]).not.toBe(failedPid)
			} finally {
				seam.killsLand = true
				await executor.close(sessionId).catch(() => {})
			}
		})

		it('publishes the pid of a failed service, then takes the claim back when it exits', async () => {
			const portPool = new PortPool()
			const harness = createServicesHarness({
				presets: [createServicesPreset([neverReadyService], ['never-ready'], portPool)],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			await session.callPluginMethod('services.start', {
				sessionId: String(session.sessionId),
				agentId: String(session.getEntryAgentId()!),
				serviceType: 'never-ready',
			})
			await waitForServiceStateStatus(session, 'never-ready', 'failed')

			// The timeout publishes the pid before reclaiming it: if the runtime dies in
			// between, that record is all the next boot has to find the survivor with.
			const events = await session.getEventsByType(serviceEvents, 'service_status_changed')
			const failures = events.filter((e) => e.serviceType === 'never-ready' && e.toStatus === 'failed')
			expect(failures[0]?.pid).toBeDefined()

			// Once the process is confirmed gone the claim goes with it, so no later boot
			// hunts for a pid the kernel may have handed to somebody else.
			await waitFor(
				() => selectPluginState<Map<string, ServiceEntry>>(session.state, 'services')?.get('never-ready')?.pid === undefined,
				() => `pid ${selectPluginState<Map<string, ServiceEntry>>(session.state, 'services')?.get('never-ready')?.pid}`,
			)
			const entry = selectPluginState<Map<string, ServiceEntry>>(session.state, 'services')?.get('never-ready')
			expect(entry?.status).toBe('failed')
			expect(entry?.error).toContain('timed out')
		})
	})

	describe('session close cleanup', () => {
		it('closing session stops running services', async () => {
			const portPool = new PortPool()
			const harness = createServicesHarness({
				presets: [createServicesPreset([quickService], ['quick'], portPool)],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			const entryAgentId = session.getEntryAgentId()!
			await session.callPluginMethod('services.start', {
				sessionId: String(session.sessionId),
				agentId: String(entryAgentId),
				serviceType: 'quick',
			})
			await waitForServiceStatus(session, 'quick', 'ready')

			// Close session → should stop services
			await session.close()

			// Wait for stopped event
			await waitForServiceStatus(session, 'quick', 'stopped', 10000)

			const events = await session.getEventsByType(serviceEvents, 'service_status_changed')
			const stoppedEvent = events.find((e) => e.serviceType === 'quick' && e.toStatus === 'stopped')
			expect(stoppedEvent).toBeDefined()
		})

		it('restarting a running service replaces its process', async () => {
			const config: ServiceConfig = {
				type: 'restart-svc',
				description: 'Restarted through the plugin method',
				command: 'sleep 60',
				gracefulStopMs: 50,
			}
			const harness = createServicesHarness({
				presets: [createServicesPreset([config], ['restart-svc'], new PortPool())],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})
			const session = await harness.createSession('test')

			await session.callPluginMethod('services.start', { serviceType: 'restart-svc' })
			await waitForServiceStateStatus(session, 'restart-svc', 'ready')
			const originalPid = selectPluginState<Map<string, ServiceEntry>>(session.state, 'services')?.get('restart-svc')?.pid
			if (originalPid === undefined) throw new Error('Service did not report its pid')

			const restarted = await session.callPluginMethod('services.restart', { serviceType: 'restart-svc' })
			expect(restarted.ok).toBe(true)
			await waitForServiceStateStatus(session, 'restart-svc', 'ready')
			const replacementPid = selectPluginState<Map<string, ServiceEntry>>(session.state, 'services')?.get('restart-svc')?.pid
			expect(replacementPid).toBeDefined()
			expect(replacementPid).not.toBe(originalPid)
			expect(() => process.kill(originalPid, 0)).toThrow()
		})

		it('an externally killed service transitions to failed', async () => {
			const platform = createNodePlatform()
			const executor = new ServiceExecutor(silentLogger, new PortPool(), { fs: platform.fs, process: platform.process })
			const config: ServiceConfig = {
				type: 'crash-svc',
				description: 'Process killed externally',
				command: 'sleep 60',
			}
			let pid: number | undefined
			executor.onStatusChanged = (_sessionId, _serviceType, status, details) => {
				if (status === 'starting') pid = details.pid
			}

			try {
				await executor.start(config, SessionId('s-external-crash'))
				if (pid === undefined) throw new Error('Service did not report its pid')
				process.kill(-pid, 'SIGKILL')
				await waitFor(
					() => executor.getStatus('crash-svc') === 'failed',
					() => String(executor.getStatus('crash-svc')),
				)
			} finally {
				await executor.close(SessionId('s-external-crash'))
			}
		})
	})

	// =========================================================================
	// Lifecycle deadlines (ServiceExecutor unit-level)
	// =========================================================================

	describe('lifecycle transition deadlines', () => {
		it('fails a start whose command resolver never settles', async () => {
			const platform = createNodePlatform()
			const executor = new ServiceExecutor(silentLogger, new PortPool(), {
				fs: platform.fs,
				process: platform.process,
				hookTimeoutMs: 50,
			})
			const config: ServiceConfig = {
				type: 'wedged-resolver',
				description: 'Command resolver never settles',
				command: () => new Promise<string>(() => {}),
			}
			const observed: ServiceStatus[] = []
			executor.onStatusChanged = (_sessionId, _serviceType, status) => {
				observed.push(status)
			}

			try {
				const result = await executor.start(config, SessionId('s-wedged-resolver'))
				expect(result.ok).toBe(false)
				if (result.ok) throw new Error('Expected the start to fail')
				expect(result.error.message).toContain('command resolver did not settle')
				expect(observed).toEqual(['failed'])
			} finally {
				await executor.close(SessionId('s-wedged-resolver'))
			}
		})

		it('kills the child and fails the start when the PID registry never settles', async () => {
			const platform = createNodePlatform()
			const killed: Array<{ pid: number; signal: string | number | undefined }> = []
			const executor = new ServiceExecutor(silentLogger, new PortPool(), {
				fs: platform.fs,
				process: platform.process,
				hookTimeoutMs: 50,
				kill: (pid, signal) => {
					killed.push({ pid, signal: signal === undefined ? undefined : signal })
					return process.kill(pid, signal)
				},
				pidRegistry: {
					record: () => new Promise<void>(() => {}),
					forget: async () => {},
				},
			})
			const config: ServiceConfig = {
				type: 'wedged-registry',
				description: 'PID registry never settles',
				command: 'sleep 60',
			}

			try {
				const result = await executor.start(config, SessionId('s-wedged-registry'))
				expect(result.ok).toBe(false)
				if (result.ok) throw new Error('Expected the start to fail')
				expect(result.error.message).toContain('could not record its PID')
				// An unrecorded child could never be reaped after a crash, so the failed
				// start must not leave it running.
				expect(killed).toHaveLength(1)
				expect(killed[0].signal).toBe('SIGKILL')
				expect(killed[0].pid).toBeLessThan(0)
			} finally {
				await executor.close(SessionId('s-wedged-registry'))
			}
		})
	})

	// =========================================================================
	// Port conflict recovery + concurrent start (ServiceExecutor unit-level)
	// =========================================================================

	describe('port conflict recovery and concurrent start', () => {
		it('drains a start blocked before PID registration during disposal', async () => {
			const child = new ChildProcess()
			Object.defineProperties(child, {
				pid: { value: 424_900 },
				stdin: { value: null },
				stdout: { value: new EventEmitter() },
				stderr: { value: new EventEmitter() },
			})
			const recordStarted = Promise.withResolvers<void>()
			const releaseRecord = Promise.withResolvers<void>()
			let spawnCount = 0
			let killed = false
			const platform = createNodePlatform()
			const executor = new ServiceExecutor(silentLogger, new PortPool(), {
				fs: platform.fs,
				process: {
					spawn: () => {
						spawnCount++
						return child
					},
					execFile: async () => {
						throw new Error('Unexpected execFile call')
					},
				},
				pidRegistry: {
					record: async () => {
						recordStarted.resolve()
						await releaseRecord.promise
					},
					forget: async () => {},
				},
				kill: () => {
					killed = true
					return true
				},
			})
			const config: ServiceConfig = { type: 'blocked-register', description: 'Blocked registration', command: 'unused' }
			const sessionId = SessionId('s-blocked-register')

			const start = executor.start(config, sessionId)
			await recordStarted.promise
			const close = executor.close(sessionId)
			const lateStart = await executor.start(config, sessionId)
			expect(lateStart.ok).toBe(false)
			expect(spawnCount).toBe(1)
			releaseRecord.resolve()
			expect((await start).ok).toBe(false)
			await close
			expect(killed).toBe(true)
			expect(executor.getStatus(config.type)).toBeNull()
		})

		it('cancels a queued port-conflict retry during disposal', async () => {
			const child = new ChildProcess()
			const stdout = new EventEmitter()
			const stderr = new EventEmitter()
			Object.defineProperties(child, {
				pid: { value: 424_950 },
				stdin: { value: null },
				stdout: { value: stdout },
				stderr: { value: stderr },
			})
			let spawnCount = 0
			const platform = createNodePlatform()
			const executor = new ServiceExecutor(silentLogger, new PortPool(), {
				fs: platform.fs,
				process: {
					spawn: () => {
						spawnCount++
						return child
					},
					execFile: async () => {
						throw new Error('Unexpected execFile call')
					},
				},
			})
			const config: ServiceConfig = { type: 'queued-conflict', description: 'Queued conflict', command: 'unused' }
			const sessionId = SessionId('s-queued-conflict')

			expect((await executor.start(config, sessionId)).ok).toBe(true)
			stderr.emit('data', Buffer.from('listen EADDRINUSE\n'))
			child.emit('close', 1)
			await executor.close(sessionId)
			await new Promise((resolve) => setTimeout(resolve, 20))
			expect(spawnCount).toBe(1)
			expect((await executor.start(config, sessionId)).ok).toBe(false)
		})

		const waitUntil = async (predicate: () => boolean, timeoutMs = 8000): Promise<void> => {
			const deadline = Date.now() + timeoutMs
			while (Date.now() < deadline) {
				if (predicate()) return
				await new Promise((r) => setTimeout(r, 20))
			}
		}

		it('collapses concurrent start() calls onto a single process', async () => {
			const platform = createNodePlatform()
			const executor = new ServiceExecutor(silentLogger, new PortPool(), { fs: platform.fs, process: platform.process })
			const marker = join(tmpdir(), `roj-svc-mutex-${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
			const config: ServiceConfig = {
				type: 'concurrent',
				description: 'appends one line per spawned process',
				command: `echo spawned >> ${marker} && sleep 30`,
			}

			try {
				const [r1, r2] = await Promise.all([
					executor.start(config, SessionId('s-concurrent')),
					executor.start(config, SessionId('s-concurrent')),
				])
				expect(r1.ok).toBe(true)
				expect(r2.ok).toBe(true)

				// Let the shell flush its append.
				await new Promise((r) => setTimeout(r, 400))
				const lines = (await readFile(marker, 'utf-8')).split('\n').filter((l) => l.length > 0)
				// Without the in-flight lock both starts spawn and the file gets two lines.
				expect(lines.length).toBe(1)
			} finally {
				await executor.close(SessionId('s-concurrent'))
				await rm(marker, { force: true })
			}
		})

		it('recovers on a fresh port when the chosen port is in use (EADDRINUSE)', async () => {
			const platform = createNodePlatform()
			const executor = new ServiceExecutor(silentLogger, new PortPool(), { fs: platform.fs, process: platform.process })
			const marker = join(tmpdir(), `roj-svc-eaddr-${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
			// First spawn fails with an EADDRINUSE-style message; the marker makes the
			// retry (a fresh process) succeed and match the ready pattern.
			const config: ServiceConfig = {
				type: 'flaky-port',
				description: 'EADDRINUSE on first attempt, ready on retry',
				command:
					`if [ -f ${marker} ]; then echo "listening READY"; sleep 30; else touch ${marker}; echo "error: listen EADDRINUSE: address already in use" 1>&2; exit 1; fi`,
				readyPattern: 'READY',
				startupTimeoutMs: 5000,
			}

			const observed: Array<{ status: ServiceStatus; port?: number }> = []
			executor.onStatusChanged = (_sessionId, _serviceType, status, details) => {
				observed.push({ status, port: details.port })
			}

			try {
				const [firstResult, concurrentResult] = await Promise.all([
					executor.start(config, SessionId('s-flaky')),
					executor.start(config, SessionId('s-flaky')),
				])
				expect(firstResult.ok).toBe(true)
				expect(concurrentResult.ok).toBe(true)

				await waitUntil(() => executor.getStatus('flaky-port') === 'ready')
				expect(executor.getStatus('flaky-port')).toBe('ready')

				// Two 'starting' events: the conflicted port, then a fresh, different one.
				const startingPorts = observed.filter((e) => e.status === 'starting').map((e) => e.port)
				expect(startingPorts.length).toBe(2)
				expect(startingPorts[0]).not.toBe(startingPorts[1])

				// The transient EADDRINUSE must NOT surface as a terminal failure.
				expect(observed.some((e) => e.status === 'failed')).toBe(false)
			} finally {
				await executor.close(SessionId('s-flaky'))
				await rm(marker, { force: true })
			}
		})

		it('retries a setup-window conflict inside the shared start and waits for registry deletion', async () => {
			const children = [new ChildProcess(), new ChildProcess()]
			const streams = children.map(() => ({ stdout: new EventEmitter(), stderr: new EventEmitter() }))
			for (const [index, child] of children.entries()) {
				Object.defineProperties(child, {
					pid: { value: 425_000 + index },
					stdin: { value: null },
					stdout: { value: streams[index]?.stdout },
					stderr: { value: streams[index]?.stderr },
				})
			}
			let spawnCount = 0
			const processRunner: ProcessRunner = {
				spawn: () => {
					const child = children[spawnCount]
					if (!child) throw new Error(`Unexpected spawn ${spawnCount + 1}`)
					spawnCount += 1
					return child
				},
				execFile: async (): Promise<ExecFileResult> => {
					throw new Error('Unexpected execFile call')
				},
			}
			const firstRecordStarted = Promise.withResolvers<void>()
			const releaseFirstRecord = Promise.withResolvers<void>()
			const forgetStarted = Promise.withResolvers<void>()
			const releaseForget = Promise.withResolvers<void>()
			const operations: string[] = []
			let currentRecordedPid: number | undefined
			let recordCount = 0
			const platform = createNodePlatform()
			const executor = new ServiceExecutor(silentLogger, new PortPool(), {
				fs: platform.fs,
				process: processRunner,
				pidRegistry: {
					record: async (record) => {
						recordCount += 1
						operations.push(`record:${record.pid}`)
						currentRecordedPid = record.pid
						if (recordCount === 1) {
							firstRecordStarted.resolve()
							await releaseFirstRecord.promise
						}
					},
					forget: async () => {
						operations.push('forget:start')
						forgetStarted.resolve()
						await releaseForget.promise
						currentRecordedPid = undefined
						operations.push('forget:end')
					},
				},
			})
			const observed: ServiceStatus[] = []
			executor.onStatusChanged = (_sessionId, _serviceType, status) => observed.push(status)
			const config: ServiceConfig = {
				type: 'controlled-conflict',
				description: 'Conflict during blocked setup',
				command: 'unused',
				readyPattern: 'READY',
			}

			try {
				const firstStart = executor.start(config, SessionId('s-controlled-conflict'))
				const concurrentStart = executor.start(config, SessionId('s-controlled-conflict'))
				await firstRecordStarted.promise
				streams[0]?.stderr.emit('data', Buffer.from('listen EADDRINUSE\n'))
				children[0]?.emit('close', 1)
				releaseFirstRecord.resolve()
				await forgetStarted.promise
				expect(spawnCount).toBe(1)
				expect(recordCount).toBe(1)

				releaseForget.resolve()
				await waitFor(() => spawnCount === 2, () => `spawnCount=${spawnCount}`)
				streams[1]?.stdout.emit('data', Buffer.from('READY\n'))
				const [firstResult, concurrentResult] = await Promise.all([firstStart, concurrentStart])
				expect(firstResult).toBe(concurrentResult)
				expect(firstResult.ok).toBe(true)
				expect(spawnCount).toBe(2)
				expect(recordCount).toBe(2)
				expect(currentRecordedPid).toBe(425_001)
				expect(operations).toEqual(['record:425000', 'forget:start', 'forget:end', 'record:425001'])
				expect(observed).toEqual(['starting', 'starting', 'ready'])
				expect(executor.getStatus('controlled-conflict')).toBe('ready')

				children[1]?.emit('close', 1)
				await waitFor(() => executor.getStatus('controlled-conflict') === 'failed', () => String(executor.getStatus('controlled-conflict')))
			} finally {
				releaseFirstRecord.resolve()
				releaseForget.resolve()
				await executor.close(SessionId('s-controlled-conflict'))
			}
		})

		const exercisePidForgetBarrier = async (mode: 'explicit' | 'automatic'): Promise<void> => {
			const children = [new ChildProcess(), new ChildProcess()]
			for (const [index, child] of children.entries()) {
				Object.defineProperties(child, {
					pid: { value: 425_100 + index },
					stdin: { value: null },
					stdout: { value: new EventEmitter() },
					stderr: { value: new EventEmitter() },
				})
			}
			let spawnCount = 0
			const processRunner: ProcessRunner = {
				spawn: () => {
					const child = children[spawnCount]
					if (!child) throw new Error(`Unexpected spawn ${spawnCount + 1}`)
					spawnCount += 1
					return child
				},
				execFile: async (): Promise<ExecFileResult> => {
					throw new Error('Unexpected execFile call')
				},
			}
			const forgetStarted = Promise.withResolvers<void>()
			const releaseForget = Promise.withResolvers<void>()
			const operations: string[] = []
			let currentRecordedPid: number | undefined
			const terminated = new Set<number>()
			const processGone = (): Error => {
				const error = new Error('ESRCH')
				Object.defineProperty(error, 'code', { value: 'ESRCH' })
				return error
			}
			const platform = createNodePlatform()
			const executor = new ServiceExecutor(silentLogger, new PortPool(), {
				fs: platform.fs,
				process: processRunner,
				pidRegistry: {
					record: async (record) => {
						operations.push(`record:${record.pid}`)
						currentRecordedPid = record.pid
					},
					forget: async () => {
						operations.push('forget:start')
						forgetStarted.resolve()
						await releaseForget.promise
						currentRecordedPid = undefined
						operations.push('forget:end')
					},
				},
				kill: (pid, signal) => {
					const processId = Math.abs(pid)
					if (signal === 0) {
						if (terminated.has(processId)) throw processGone()
						return true
					}
					terminated.add(processId)
					children[processId - 425_100]?.emit('close', 0)
					return true
				},
			})
			const config: ServiceConfig = {
				type: `pid-forget-${mode}`,
				description: 'Replacement waits for durable PID deletion',
				command: 'unused',
				restartPolicy: mode === 'automatic' ? { maxRetries: 1, initialDelayMs: 0 } : undefined,
			}

			try {
				await executor.start(config, SessionId(`s-pid-forget-${mode}`))
				let explicitRestart: ReturnType<ServiceExecutor['restart']> | undefined
				if (mode === 'explicit') {
					explicitRestart = executor.restart(config, SessionId('s-pid-forget-explicit'))
				} else {
					children[0]?.emit('close', 1)
				}

				await forgetStarted.promise
				await new Promise((resolve) => setTimeout(resolve, 25))
				expect(spawnCount).toBe(1)
				expect(currentRecordedPid).toBe(425_100)

				releaseForget.resolve()
				if (explicitRestart) expect((await explicitRestart).ok).toBe(true)
				await waitFor(() => spawnCount === 2 && executor.getStatus(config.type) === 'ready', () => `spawnCount=${spawnCount}, status=${executor.getStatus(config.type)}`)
				expect(currentRecordedPid).toBe(425_101)
				expect(operations.slice(0, 4)).toEqual(['record:425100', 'forget:start', 'forget:end', 'record:425101'])
			} finally {
				releaseForget.resolve()
				await executor.close(SessionId(`s-pid-forget-${mode}`))
			}
		}

		it('blocks explicit replacement until the old PID record is deleted', async () => {
			await exercisePidForgetBarrier('explicit')
		})

		it('blocks zero-delay automatic replacement until the old PID record is deleted', async () => {
			await exercisePidForgetBarrier('automatic')
		})
	})

	describe('process group termination', () => {
		const systemError = (code: string): Error => {
			const error = new Error(code)
			Object.defineProperty(error, 'code', { value: code })
			return error
		}

		const isPidTerminated = async (pid: number): Promise<boolean> => {
			try {
				const stat = await readFile(`/proc/${pid}/stat`, 'utf-8')
				const rparen = stat.lastIndexOf(')')
				return rparen !== -1 && stat.slice(rparen + 2).startsWith('Z ')
			} catch {
				return true
			}
		}

		it('detaches status callbacks when close cannot terminate a service', async () => {
			const child = new ChildProcess()
			Object.defineProperties(child, {
				pid: { value: 425_900 },
				stdin: { value: null },
				stdout: { value: new EventEmitter() },
				stderr: { value: new EventEmitter() },
			})
			const processRunner: ProcessRunner = {
				spawn: () => child,
				execFile: async (): Promise<ExecFileResult> => {
					throw new Error('Unexpected execFile call')
				},
			}
			const platform = createNodePlatform()
			const executor = new ServiceExecutor(silentLogger, new PortPool(), {
				fs: platform.fs,
				process: processRunner,
				kill: (_pid, signal) => {
					if (signal === 0) return true
					throw systemError('EIO')
				},
			})
			const observed: ServiceStatus[] = []
			executor.onStatusChanged = (_sessionId, _serviceType, status) => observed.push(status)
			await executor.start({
				type: 'failed-close',
				description: 'Cannot be terminated during close',
				command: 'unused',
			}, SessionId('s-failed-close'))

			await expect(executor.close(SessionId('s-failed-close'))).rejects.toThrow('Failed to send SIGTERM')
			expect(executor.onStatusChanged).toBeUndefined()
			const observedCount = observed.length
			child.emit('close', 1)
			expect(observed).toHaveLength(observedCount)
		})

		it('releases the port and clears state even when close cannot signal the process', async () => {
			const child = new ChildProcess()
			Object.defineProperties(child, {
				pid: { value: 427_000 },
				stdin: { value: null },
				stdout: { value: new EventEmitter() },
				stderr: { value: new EventEmitter() },
			})
			const processRunner: ProcessRunner = {
				spawn: () => child,
				execFile: async (): Promise<ExecFileResult> => {
					throw new Error('Unexpected execFile call')
				},
			}
			const platform = createNodePlatform()
			const portPool = new PortPool()
			const executor = new ServiceExecutor(silentLogger, portPool, {
				fs: platform.fs,
				process: processRunner,
				kill: (_pid, signal) => {
					if (signal === 0) return true
					throw systemError('EIO')
				},
			})
			let port: number | undefined
			executor.onStatusChanged = (_sessionId, _serviceType, _status, details) => {
				if (details.port !== undefined) port = details.port
			}
			const sessionId = SessionId('s-port-leak')
			await executor.start({ type: 'stubborn', description: 'Refuses SIGTERM', command: 'unused' }, sessionId)
			expect(port).toBeDefined()

			await expect(executor.close(sessionId)).rejects.toThrow('Failed to send SIGTERM')

			// The tail after the stop loop must still run. portPool is process-global, so
			// skipping the release loses that port for the life of the server.
			expect(portPool.tryAllocate(port!)).toBe(true)
			expect(executor.getStatus('stubborn')).toBeNull()
		})

		it('keeps stop retryable across permission and probe errors, then accepts ESRCH', async () => {
			const child = new ChildProcess()
			Object.defineProperties(child, {
				pid: { value: 426_000 },
				stdin: { value: null },
				stdout: { value: new EventEmitter() },
				stderr: { value: new EventEmitter() },
			})
			const processRunner: ProcessRunner = {
				spawn: () => child,
				execFile: async (): Promise<ExecFileResult> => {
					throw new Error('Unexpected execFile call')
				},
			}
			let mode: 'permission' | 'probe-error' | 'signal-error' | 'gone' = 'permission'
			const platform = createNodePlatform()
			const executor = new ServiceExecutor(silentLogger, new PortPool(), {
				fs: platform.fs,
				process: processRunner,
				kill: (_pid, signal) => {
					if (mode === 'permission') throw systemError('EPERM')
					if (mode === 'probe-error') throw systemError('EIO')
					if (mode === 'signal-error') throw systemError(signal === 0 ? 'EPERM' : 'EIO')
					if (signal === 0) throw systemError('ESRCH')
					return true
				},
			})
			await executor.start({
				type: 'retryable-stop',
				description: 'Controlled process-group errors',
				command: 'unused',
			}, SessionId('s-retryable-stop'))

			const permission = await executor.stop('retryable-stop', SessionId('s-retryable-stop'))
			expect(permission.ok).toBe(false)
			expect(executor.getStatus('retryable-stop')).toBe('ready')
			mode = 'probe-error'
			const unexpected = await executor.stop('retryable-stop', SessionId('s-retryable-stop'))
			expect(unexpected.ok).toBe(false)
			expect(executor.getStatus('retryable-stop')).toBe('ready')
			mode = 'signal-error'
			const signalFailure = await executor.stop('retryable-stop', SessionId('s-retryable-stop'))
			expect(signalFailure.ok).toBe(false)
			expect(executor.getStatus('retryable-stop')).toBe('ready')
			mode = 'gone'
			const gone = await executor.stop('retryable-stop', SessionId('s-retryable-stop'))
			expect(gone.ok).toBe(true)
			expect(executor.getStatus('retryable-stop')).toBe('stopped')
			await executor.close(SessionId('s-retryable-stop'))
		})

		it('does not restore a live status when close wins a later probe error', async () => {
			const child = new ChildProcess()
			Object.defineProperties(child, {
				pid: { value: 426_002 },
				stdin: { value: null },
				stdout: { value: new EventEmitter() },
				stderr: { value: new EventEmitter() },
			})
			const processRunner: ProcessRunner = {
				spawn: () => child,
				execFile: async (): Promise<ExecFileResult> => {
					throw new Error('Unexpected execFile call')
				},
			}
			let probeCount = 0
			const platform = createNodePlatform()
			const executor = new ServiceExecutor(silentLogger, new PortPool(), {
				fs: platform.fs,
				process: processRunner,
				kill: (_pid, signal) => {
					if (signal !== 0) return true
					probeCount += 1
					if (probeCount === 3) {
						child.emit('close', 0)
						throw systemError('EIO')
					}
					return true
				},
			})
			const observed: ServiceStatus[] = []
			executor.onStatusChanged = (_sessionId, _serviceType, status) => observed.push(status)
			await executor.start({
				type: 'close-before-probe-error',
				description: 'Close races with a process-group probe error',
				command: 'unused',
			}, SessionId('s-close-before-probe-error'))

			const stopped = await executor.stop('close-before-probe-error', SessionId('s-close-before-probe-error'))
			expect(stopped.ok).toBe(false)
			expect(executor.getStatus('close-before-probe-error')).toBe('stopped')
			expect(observed).toEqual(['starting', 'ready', 'stopping', 'stopped'])
			await executor.close(SessionId('s-close-before-probe-error'))
		})

		it('waits for a concurrent failed stop and force-stops it before releasing state', async () => {
			const child = new ChildProcess()
			Object.defineProperties(child, {
				pid: { value: 426_003 },
				stdin: { value: null },
				stdout: { value: new EventEmitter() },
				stderr: { value: new EventEmitter() },
			})
			const processRunner: ProcessRunner = {
				spawn: () => child,
				execFile: async (): Promise<ExecFileResult> => {
					throw new Error('Unexpected execFile call')
				},
			}
			const probeStarted = Promise.withResolvers<void>()
			const releaseProbe = Promise.withResolvers<void>()
			const platform = createNodePlatform()
			let gateProbe = true
			function readdir(path: string): Promise<string[]>
			function readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>
			async function readdir(path: string, options?: { withFileTypes: true }): Promise<string[] | Dirent[]> {
				if (path === '/proc' && options === undefined) {
					if (gateProbe) {
						gateProbe = false
						probeStarted.resolve()
						await releaseProbe.promise
					}
					return []
				}
				return options ? platform.fs.readdir(path, options) : platform.fs.readdir(path)
			}
			const fs: FileSystem = { ...platform.fs, readdir }
			let termAttempts = 0
			let processGone = false
			const portPool = new PortPool(12_345, 12_345)
			const executor = new ServiceExecutor(silentLogger, portPool, {
				fs,
				process: processRunner,
				kill: (_pid, signal) => {
					if (signal !== 'SIGTERM') return true
					termAttempts++
					if (termAttempts === 1) throw systemError('EIO')
					processGone = true
					throw systemError('ESRCH')
				},
			})
			const sessionId = SessionId('s-concurrent-stop-close')
			await executor.start({
				type: 'concurrent-stop-close',
				description: 'Stop blocked during close',
				command: 'unused',
			}, sessionId, undefined, 12_345)

			const stop = executor.stop('concurrent-stop-close', sessionId)
			await probeStarted.promise
			let closeSettled = false
			const close = executor.close(sessionId).then(() => {
				closeSettled = true
			})
			await Bun.sleep(0)
			expect(closeSettled).toBe(false)
			expect(executor.getStatus('concurrent-stop-close')).toBe('stopping')
			expect(portPool.tryAllocate(12_345)).toBe(false)

			releaseProbe.resolve()
			expect((await stop).ok).toBe(false)
			await close
			expect(processGone).toBe(true)
			expect(termAttempts).toBe(2)
			expect(executor.getStatus('concurrent-stop-close')).toBeNull()
			expect(portPool.tryAllocate(12_345)).toBe(true)
			portPool.release(12_345)
		})

		it('a close that cannot terminate leaves a reap-able status, not a stranded stopping', async () => {
			const child = new ChildProcess()
			Object.defineProperties(child, {
				pid: { value: 426_001 },
				stdin: { value: null },
				stdout: { value: new EventEmitter() },
				stderr: { value: new EventEmitter() },
			})
			const processRunner: ProcessRunner = {
				spawn: () => child,
				execFile: async (): Promise<ExecFileResult> => {
					throw new Error('Unexpected execFile call')
				},
			}
			const platform = createNodePlatform()
			const executor = new ServiceExecutor(silentLogger, new PortPool(), {
				fs: platform.fs,
				process: processRunner,
				kill: () => {
					throw systemError('EPERM')
				},
			})
			const observed: ServiceStatus[] = []
			executor.onStatusChanged = (_sessionId, _serviceType, status) => observed.push(status)
			await executor.start({
				type: 'stranded-stopping',
				description: 'Cannot be signalled at all',
				command: 'unused',
			}, SessionId('s-stranded-stopping'))

			await expect(executor.close(SessionId('s-stranded-stopping'))).rejects.toThrow('SIGTERM')
			// `stopping` matches neither the onSessionReady reconcile nor the
			// session_restarted reset, so a close that failed must not leave it as the
			// last word — the next runtime would never reap the process.
			expect(observed).toEqual(['starting', 'ready', 'stopping', 'ready', 'stopping', 'ready'])
		})

		const exerciseTermination = async (mode: 'stop' | 'close'): Promise<void> => {
			const platform = createNodePlatform()
			const executor = new ServiceExecutor(silentLogger, new PortPool(), { fs: platform.fs, process: platform.process })
			const fixtureDir = await mkdtemp(join(tmpdir(), `roj-svc-group-${mode}-`))
			const childFile = join(fixtureDir, 'child.pid')
			const grandchildFile = join(fixtureDir, 'grandchild.pid')
			const serviceType = `group-${mode}`
			let leaderPid: number | undefined
			executor.onStatusChanged = (_sessionId, _serviceType, status, details) => {
				if (status === 'starting') leaderPid = details.pid
			}
			const config: ServiceConfig = {
				type: serviceType,
				description: 'Leader exits on TERM while descendants ignore it',
				command:
					`sh -c 'trap "" TERM; sleep 60 & echo $! > "${grandchildFile}"; wait' & echo $! > "${childFile}"; trap 'exit 0' TERM; echo READY; wait`,
				readyPattern: 'READY',
				gracefulStopMs: 50,
			}

			try {
				await executor.start(config, SessionId(`s-${serviceType}`))
				await waitFor(() => executor.getStatus(serviceType) === 'ready', () => String(executor.getStatus(serviceType)))
				await waitForAsync(
					async () => platform.fs.exists(childFile).then(async (childExists) => childExists && await platform.fs.exists(grandchildFile)),
					() => 'waiting for child and grandchild pid files',
				)
				const childPid = Number.parseInt(await readFile(childFile, 'utf-8'), 10)
				const grandchildPid = Number.parseInt(await readFile(grandchildFile, 'utf-8'), 10)
				expect(await isPidTerminated(childPid)).toBe(false)
				expect(await isPidTerminated(grandchildPid)).toBe(false)

				if (mode === 'stop') {
					const result = await executor.stop(serviceType, SessionId(`s-${serviceType}`))
					expect(result.ok).toBe(true)
				} else {
					await executor.close(SessionId(`s-${serviceType}`))
				}

				expect(await isPidTerminated(childPid)).toBe(true)
				expect(await isPidTerminated(grandchildPid)).toBe(true)
			} finally {
				await executor.close(SessionId(`s-${serviceType}`))
				if (leaderPid !== undefined) {
					try {
						process.kill(-leaderPid, 'SIGKILL')
					} catch {
						// Already gone.
					}
				}
				await rm(fixtureDir, { recursive: true, force: true })
			}
		}

		it('stop waits for child and grandchild processes after the leader exits', async () => {
			await exerciseTermination('stop')
		})

		it('close waits for child and grandchild processes after the leader exits', async () => {
			await exerciseTermination('close')
		})
	})

	// =========================================================================
	// restartPolicy — reviving a service that exited on its own
	// =========================================================================

	describe('restartPolicy', () => {
		const waitUntil = async (predicate: () => boolean, timeoutMs = 8000): Promise<void> => {
			const deadline = Date.now() + timeoutMs
			while (Date.now() < deadline) {
				if (predicate()) return
				await new Promise((r) => setTimeout(r, 20))
			}
		}

		const waitUntilAsync = async (predicate: () => Promise<boolean>, timeoutMs = 8000): Promise<void> => {
			const deadline = Date.now() + timeoutMs
			while (Date.now() < deadline) {
				if (await predicate()) return
				await new Promise((r) => setTimeout(r, 20))
			}
		}

		const marker = (name: string) => join(tmpdir(), `roj-restart-${name}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
		/** Records every spawn, then crashes or stays up depending on the run count. */
		const crashCommand = (path: string, crashRuns: number) =>
			`echo x >> ${path}; runs=$(wc -l < ${path} | tr -d ' '); if [ "$runs" -le ${crashRuns} ]; then exit 1; fi; echo "listening READY"; sleep 30`
		const spawnCount = async (path: string): Promise<number> => {
			try {
				return (await readFile(path, 'utf-8')).split('\n').filter((l) => l.length > 0).length
			} catch {
				return 0
			}
		}

		it('revives a crashed service on the port it already holds', async () => {
			const platform = createNodePlatform()
			const executor = new ServiceExecutor(silentLogger, new PortPool(), { fs: platform.fs, process: platform.process })
			const path = marker('revive')
			const config: ServiceConfig = {
				type: 'revive-svc',
				description: 'crashes once, then stays up',
				command: crashCommand(path, 1),
				readyPattern: 'READY',
				startupTimeoutMs: 5000,
				restartPolicy: { maxRetries: 3, initialDelayMs: 20 },
			}
			const ports: number[] = []
			executor.onStatusChanged = (_s, _t, status, details) => {
				if (status === 'starting' && details.port !== undefined) ports.push(details.port)
			}

			try {
				await executor.start(config, SessionId('s-revive'))
				await waitUntil(() => executor.getStatus('revive-svc') === 'ready')
				expect(executor.getStatus('revive-svc')).toBe('ready')
				expect(await spawnCount(path)).toBe(2)
				// The preview URL must survive the bounce.
				expect(new Set(ports).size).toBe(1)
			} finally {
				await executor.close(SessionId('s-revive'))
				await rm(path, { force: true })
			}
		})

		it('leaves the service failed once the retry budget is spent', async () => {
			const platform = createNodePlatform()
			const executor = new ServiceExecutor(silentLogger, new PortPool(), { fs: platform.fs, process: platform.process })
			const path = marker('budget')
			const config: ServiceConfig = {
				type: 'budget-svc',
				description: 'always crashes',
				command: crashCommand(path, 99),
				readyPattern: 'READY',
				startupTimeoutMs: 5000,
				restartPolicy: { maxRetries: 2, initialDelayMs: 20 },
			}

			try {
				await executor.start(config, SessionId('s-budget'))
				// One initial spawn plus two retries, then it stays down.
				await waitUntilAsync(async () => (await spawnCount(path)) >= 3 && executor.getStatus('budget-svc') === 'failed')
				await new Promise((r) => setTimeout(r, 300))
				expect(await spawnCount(path)).toBe(3)
				expect(executor.getStatus('budget-svc')).toBe('failed')
			} finally {
				await executor.close(SessionId('s-budget'))
				await rm(path, { force: true })
			}
		})

		it('without a policy a crash stays a crash', async () => {
			const platform = createNodePlatform()
			const executor = new ServiceExecutor(silentLogger, new PortPool(), { fs: platform.fs, process: platform.process })
			const path = marker('nopolicy')
			const config: ServiceConfig = {
				type: 'nopolicy-svc',
				description: 'always crashes, no restartPolicy',
				command: crashCommand(path, 99),
				readyPattern: 'READY',
				startupTimeoutMs: 5000,
			}

			try {
				await executor.start(config, SessionId('s-nopolicy'))
				await waitUntil(() => executor.getStatus('nopolicy-svc') === 'failed')
				await new Promise((r) => setTimeout(r, 300))
				expect(await spawnCount(path)).toBe(1)
			} finally {
				await executor.close(SessionId('s-nopolicy'))
				await rm(path, { force: true })
			}
		})

		it('a queued revival rides along on the failed status change', async () => {
			const platform = createNodePlatform()
			const executor = new ServiceExecutor(silentLogger, new PortPool(), { fs: platform.fs, process: platform.process })
			const path = marker('event')
			const config: ServiceConfig = {
				type: 'event-svc',
				description: 'crashes once, then stays up',
				command: crashCommand(path, 1),
				readyPattern: 'READY',
				startupTimeoutMs: 5000,
				restartPolicy: { maxRetries: 3, initialDelayMs: 20 },
			}
			const changes: Array<{ status: ServiceStatus; details: ServiceStatusChangeDetails }> = []
			executor.onStatusChanged = (_s, _t, status, details) => {
				changes.push({ status, details })
			}

			try {
				await executor.start(config, SessionId('s-event'))
				await waitUntil(() => executor.getStatus('event-svc') === 'ready')

				const failedIndex = changes.findIndex((c) => c.status === 'failed')
				expect(failedIndex).toBeGreaterThanOrEqual(0)
				const failed = changes[failedIndex]!
				expect(failed.details.restartAttempt).toBe(1)
				expect(failed.details.restartMaxRetries).toBe(3)
				expect(failed.details.restartAt).toBeGreaterThan(0)

				// The revival's own start must not carry the intent it just honoured.
				const revivalStart = changes.slice(failedIndex + 1).find((c) => c.status === 'starting')
				expect(revivalStart).toBeDefined()
				expect(revivalStart!.details.restartAt).toBeUndefined()
			} finally {
				await executor.close(SessionId('s-event'))
				await rm(path, { force: true })
			}
		})

		it('the failure that spends the budget carries no revival', async () => {
			const platform = createNodePlatform()
			const executor = new ServiceExecutor(silentLogger, new PortPool(), { fs: platform.fs, process: platform.process })
			const path = marker('terminal')
			const config: ServiceConfig = {
				type: 'terminal-svc',
				description: 'always crashes',
				command: crashCommand(path, 99),
				readyPattern: 'READY',
				startupTimeoutMs: 5000,
				restartPolicy: { maxRetries: 1, initialDelayMs: 20 },
			}
			const failures: ServiceStatusChangeDetails[] = []
			executor.onStatusChanged = (_s, _t, status, details) => {
				if (status === 'failed') failures.push(details)
			}

			try {
				await executor.start(config, SessionId('s-terminal'))
				await waitUntilAsync(async () => (await spawnCount(path)) >= 2 && failures.length >= 2)
				expect(failures[0]?.restartAttempt).toBe(1)
				expect(failures[1]?.restartAt).toBeUndefined()
				expect(failures[1]?.restartAttempt).toBeUndefined()
			} finally {
				await executor.close(SessionId('s-terminal'))
				await rm(path, { force: true })
			}
		})

		it('session state shows the queued revival and drops it once called off', async () => {
			const portPool = new PortPool()
			const config: ServiceConfig = {
				type: 'reviving',
				description: 'crashes early, revival queued behind a long delay',
				// The sleep keeps the exit from beating the executor's close listener.
				command: 'sleep 0.2; exit 1',
				restartPolicy: { maxRetries: 3, initialDelayMs: 3000 },
			}
			const harness = createServicesHarness({
				presets: [createServicesPreset([config], ['reviving'], portPool)],
			})
			const session = await harness.createSession('test')

			await session.callPluginMethod('services.start', { serviceType: 'reviving' })
			await waitForServiceStateStatus(session, 'reviving', 'failed')

			const entry = selectPluginState<Map<string, ServiceEntry>>(session.state, 'services')?.get('reviving')
			expect(entry?.status).toBe('failed')
			expect(entry?.restartAt).toBeGreaterThan(Date.now())
			expect(entry?.restartAttempt).toBe(1)
			expect(entry?.restartMaxRetries).toBe(3)

			const stopped = await session.callPluginMethod('services.stop', { serviceType: 'reviving' })
			expect(stopped.ok).toBe(true)
			await waitForServiceStateStatus(session, 'reviving', 'stopped')

			const after = selectPluginState<Map<string, ServiceEntry>>(session.state, 'services')?.get('reviving')
			expect(after?.status).toBe('stopped')
			expect(after?.restartAt).toBeUndefined()
			expect(after?.restartAttempt).toBeUndefined()
		})

		it('closing the session calls off a queued revival', async () => {
			const portPool = new PortPool()
			const path = marker('close')
			const config: ServiceConfig = {
				type: 'close-svc',
				description: 'crashes early, revival queued behind a delay',
				// The sleep keeps the exit from beating the executor's close listener.
				command: `echo x >> ${path}; sleep 0.2; exit 1`,
				restartPolicy: { maxRetries: 3, initialDelayMs: 800 },
			}
			const harness = createServicesHarness({
				presets: [createServicesPreset([config], ['close-svc'], portPool)],
			})
			const session = await harness.createSession('test')

			try {
				await session.callPluginMethod('services.start', { serviceType: 'close-svc' })
				await waitForServiceStateStatus(session, 'close-svc', 'failed')
				expect(await spawnCount(path)).toBe(1)

				await session.close()
				// Long enough for the revival to have fired had nothing called it off.
				await new Promise((r) => setTimeout(r, 1500))
				expect(await spawnCount(path)).toBe(1)
			} finally {
				await rm(path, { force: true })
			}
		})

		it('an explicit stop calls off a queued revival', async () => {
			const platform = createNodePlatform()
			const executor = new ServiceExecutor(silentLogger, new PortPool(), { fs: platform.fs, process: platform.process })
			const path = marker('stop')
			const config: ServiceConfig = {
				type: 'stop-svc',
				description: 'always crashes, revival queued behind a long delay',
				command: crashCommand(path, 99),
				readyPattern: 'READY',
				startupTimeoutMs: 5000,
				restartPolicy: { maxRetries: 3, initialDelayMs: 1500 },
			}

			try {
				await executor.start(config, SessionId('s-stop'))
				await waitUntil(() => executor.getStatus('stop-svc') === 'failed')
				const stopped = await executor.stop('stop-svc', SessionId('s-stop'))
				expect(stopped.ok).toBe(true)
				expect(executor.getStatus('stop-svc')).toBe('stopped')
				await new Promise((r) => setTimeout(r, 2000))
				expect(await spawnCount(path)).toBe(1)
			} finally {
				await executor.close(SessionId('s-stop'))
				await rm(path, { force: true })
			}
		})
	})

	// =========================================================================
	// agentVisible: false — infrastructure services hidden from agents
	// =========================================================================

	describe('agentVisible: false services', () => {
		const hiddenService: ServiceConfig = {
			type: 'hidden-svc',
			description: 'Infra service driven by the platform, not agents',
			command: 'sleep 60',
			agentVisible: false,
		}

		it('auto-wired agent visibility excludes it: no tool mention, no status line, still method-controllable', async () => {
			const portPool = new PortPool()
			const base = createTestPreset({
				plugins: [servicePlugin.configure({ services: [quickService, hiddenService], portPool })],
			})
			// Services attached on the agent definition (defineAgent-style auto-wiring),
			// NOT via explicit configureAgent — exercises the getAgentConfig filter.
			const preset = { ...base, orchestrator: { ...base.orchestrator, services: [quickService, hiddenService] } }
			const harness = createServicesHarness({
				presets: [preset],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			// Service tools exist (quick is visible) but never mention the hidden service
			const lastRequest = harness.llmProvider.getLastRequest()
			const serviceStart = lastRequest?.tools?.find((t) => t.name === 'service_start')
			expect(serviceStart).toBeDefined()
			expect(serviceStart?.description).toContain('quick')
			expect(serviceStart?.description).not.toContain('hidden-svc')

			// The session-context status block skips it too
			const serialized = JSON.stringify(lastRequest?.messages ?? [])
			expect(serialized).not.toContain('hidden-svc')

			// Still fully controllable at the session level via services.* methods
			const entryAgentId = session.getEntryAgentId()!
			const startResult = await session.callPluginMethod('services.start', {
				sessionId: String(session.sessionId),
				agentId: String(entryAgentId),
				serviceType: 'hidden-svc',
			})
			expect(startResult).toMatchObject({ ok: true })
			await waitForServiceStatus(session, 'hidden-svc', 'ready')

			const statusResult = await session.callPluginMethod('services.status', {
				sessionId: String(session.sessionId),
				agentId: String(entryAgentId),
				serviceType: 'hidden-svc',
			})
			expect(statusResult).toMatchObject({ ok: true, value: { status: 'ready' } })
		})
	})

	// =========================================================================
	// Real host paths must not leak into agent-facing surfaces
	// =========================================================================

	describe('host path hygiene', () => {
		it('status block omits cwd even when the entry tracks one', () => {
			const message = buildServiceStatusMessage(
				[{
					serviceType: 'quick',
					status: 'ready',
					stoppedBy: 'never',
					port: 4321,
					cwd: '/home/user/sessions/0000-real-host-path/packages/web',
				}],
				[quickService],
			)
			expect(message).toContain('quick')
			expect(message).toContain('port 4321')
			expect(message).not.toContain('real-host-path')
			expect(message).not.toContain('cwd')
		})

		it('service_status tool output strips cwd', async () => {
			const portPool = new PortPool()
			// Absolute cwd so the tracked entry actually carries a host path to leak.
			const cwdService: ServiceConfig = {
				type: 'cwd-svc',
				description: 'Service with a resolved host cwd',
				command: 'sleep 60',
				cwd: tmpdir(),
			}
			const harness = createServicesHarness({
				presets: [createServicesPreset([cwdService], ['cwd-svc'], portPool)],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc-start'),
							name: 'service_start',
							input: { serviceType: 'cwd-svc' },
						}],
					},
					{
						toolCalls: [{
							id: ToolCallId('tc-status'),
							name: 'service_status',
							input: { serviceType: 'cwd-svc' },
						}],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Check the service')
			await waitForServiceStatus(session, 'cwd-svc', 'ready')

			// The service_status tool result (fed back as a message) must not carry cwd,
			// while the session-level method keeps returning it for platform callers.
			const serialized = JSON.stringify(harness.llmProvider.getLastRequest()?.messages ?? [])
			expect(serialized).not.toContain('"cwd"')

			const entryAgentId = session.getEntryAgentId()!
			const statusResult = await session.callPluginMethod('services.status', {
				sessionId: String(session.sessionId),
				agentId: String(entryAgentId),
				serviceType: 'cwd-svc',
			})
			expect(statusResult).toMatchObject({ ok: true, value: { cwd: expect.any(String) } })
		})
	})
})
