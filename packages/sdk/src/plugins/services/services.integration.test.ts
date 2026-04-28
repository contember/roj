import { afterEach, describe, expect, it } from 'bun:test'
import { MemoryEventStore } from '~/core/events/memory.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import { selectPluginState } from '~/core/sessions/reducer.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { createTestPreset, TestHarness } from '~/testing/index.js'
import { serviceEvents, servicePlugin } from './plugin.js'
import type { ServiceAgentConfig, ServicePluginConfig } from './plugin.js'
import { PortPool } from './port-pool.js'
import type { ServiceConfig, ServiceEntry } from './schema.js'

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
}

// ============================================================================
// Tests
// ============================================================================

describe('services plugin', () => {
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
			expect(quickEvents.length).toBeGreaterThanOrEqual(1)
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
			expect(autoEvents.length).toBeGreaterThanOrEqual(1)
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

			// Harness 1: start service, capture pid + port, then "crash" (shutdown
			// without running onSessionClose — matches session.shutdown() behavior).
			const harness1 = new TestHarness({
				presets: [createServicesPreset([quickService], ['quick'], new PortPool())],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
				systemPlugins: [servicePlugin],
				eventStore,
			})

			const session1 = await harness1.createSession('test')
			await session1.sendAndWaitForIdle('Hi')

			const entryAgentId = session1.getEntryAgentId()!
			await session1.callPluginMethod('services.start', {
				sessionId: String(session1.sessionId),
				agentId: String(entryAgentId),
				serviceType: 'quick',
			})
			await waitForServiceStateStatus(session1, 'quick', 'ready')

			const stateBefore = selectPluginState<Map<string, ServiceEntry>>(session1.state, 'services')?.get('quick')
			const orphanPid = stateBefore?.pid
			const orphanPort = stateBefore?.port
			expect(orphanPid).toBeDefined()
			expect(orphanPort).toBeDefined()

			// Process should be alive before restart
			expect(() => process.kill(orphanPid!, 0)).not.toThrow()

			const sessionId = session1.sessionId

			// Simulate server crash: sessionManager.shutdown() clears in-memory state
			// but does NOT run onSessionClose, so the detached service process survives.
			await harness1.sessionManager.shutdown()

			// Orphan must still be alive after "crash"
			expect(() => process.kill(orphanPid!, 0)).not.toThrow()

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
					process.kill(orphanPid!, 0)
				} catch {
					break
				}
				await new Promise((r) => setTimeout(r, 50))
			}

			let isAlive = true
			try {
				process.kill(orphanPid!, 0)
			} catch {
				isAlive = false
			}
			// Safety net in case reconcile didn't kill it — don't leave zombies behind
			if (isAlive) {
				try {
					process.kill(-orphanPid!, 'SIGKILL')
				} catch {
					// already gone
				}
			}
			expect(isAlive).toBe(false)

			// Port preserved in state — next start() would receive it via preferredPort
			const stateAfter = selectPluginState<Map<string, ServiceEntry>>(session2.state, 'services')?.get('quick')
			expect(stateAfter?.status).toBe('stopped')
			expect(stateAfter?.port).toBe(orphanPort!)
			expect(stateAfter?.pid).toBeUndefined()
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
	})
})
