import { afterEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryEventStore } from '~/core/events/memory.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import { selectPluginState } from '~/core/sessions/reducer.js'
import { SessionId } from '~/core/sessions/schema.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { silentLogger } from '~/lib/logger/logger.js'
import { createNodePlatform } from '~/testing/node-platform.js'
import { createTestPreset, TestHarness } from '~/testing/index.js'
import { serviceEvents, servicePlugin } from './plugin.js'
import type { ServiceAgentConfig, ServicePluginConfig } from './plugin.js'
import { PortPool } from './port-pool.js'
import type { ServiceCommandArgs, ServiceConfig, ServiceCwdArgs, ServiceEntry, ServiceStatus } from './schema.js'
import { ServiceExecutor } from './service.js'

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

	// =========================================================================
	// Port conflict recovery + concurrent start (ServiceExecutor unit-level)
	// =========================================================================

	describe('port conflict recovery and concurrent start', () => {
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
				await executor.shutdown()
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
				const result = await executor.start(config, SessionId('s-flaky'))
				expect(result.ok).toBe(true)

				await waitUntil(() => executor.getStatus('flaky-port') === 'ready')
				expect(executor.getStatus('flaky-port')).toBe('ready')

				// Two 'starting' events: the conflicted port, then a fresh, different one.
				const startingPorts = observed.filter((e) => e.status === 'starting').map((e) => e.port)
				expect(startingPorts.length).toBe(2)
				expect(startingPorts[0]).not.toBe(startingPorts[1])

				// The transient EADDRINUSE must NOT surface as a terminal failure.
				expect(observed.some((e) => e.status === 'failed')).toBe(false)
			} finally {
				await executor.shutdown()
				await rm(marker, { force: true })
			}
		})
	})
})
