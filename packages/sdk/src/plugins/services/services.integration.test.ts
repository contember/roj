import { afterEach, describe, expect, it } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryEventStore } from '~/core/events/memory.js'
import { withSessionId } from '~/core/events/test-helpers.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import { selectPluginState } from '~/core/sessions/reducer.js'
import { SessionId } from '~/core/sessions/schema.js'
import { sessionEvents } from '~/core/sessions/state.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { silentLogger } from '~/lib/logger/logger.js'
import { createNodePlatform } from '~/testing/node-platform.js'
import { createTestPreset, TestHarness } from '~/testing/index.js'
import { serviceEvents, servicePlugin } from './plugin.js'
import type { ServiceAgentConfig, ServicePluginConfig } from './plugin.js'
import { PortPool } from './port-pool.js'
import { buildServiceStatusMessage } from './prompt.js'
import type { ServiceCommandArgs, ServiceConfig, ServiceCwdArgs, ServiceEntry, ServiceStatus } from './schema.js'
import type { ServiceStatusChangeDetails } from './service.js'
import { getProcessStartTime, ServiceExecutor } from './service.js'

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

	// =========================================================================
	// Reclaiming processes a service entry stopped tracking
	// =========================================================================

	describe('reclaiming abandoned service processes', () => {
		/** A detached `sleep`, standing in for a dev server that outlived its service entry. */
		function spawnVictim(): number {
			const child = spawn('/bin/sh', ['-c', 'sleep 60'], { detached: true, stdio: 'ignore' })
			child.unref()
			if (!child.pid) throw new Error('failed to spawn victim')
			return child.pid
		}

		const isAlive = (pid: number): boolean => {
			try {
				process.kill(pid, 0)
				return true
			} catch {
				return false
			}
		}

		const killGroup = (pid: number): void => {
			try {
				process.kill(-pid, 'SIGKILL')
			} catch {
				// Already gone.
			}
		}

		const waitUntil = async (predicate: () => boolean, timeoutMs = 5000): Promise<void> => {
			const deadline = Date.now() + timeoutMs
			while (Date.now() < deadline) {
				if (predicate()) return
				await new Promise((r) => setTimeout(r, 20))
			}
		}

		/**
		 * Poll rather than assert straight away — the kernel reaps on its own schedule.
		 * Kept under bun's per-test timeout so a leak fails on the assertion, not the clock.
		 */
		const waitForDeath = (pid: number): Promise<void> => waitUntil(() => !isAlive(pid), 3000)

		const makeExecutor = () => {
			const platform = createNodePlatform()
			return new ServiceExecutor(silentLogger, new PortPool(), { fs: platform.fs, process: platform.process })
		}

		const neverReadyService: ServiceConfig = {
			type: 'never-ready',
			description: 'outlives its readiness window',
			command: 'sleep 60',
			readyPattern: 'THIS NEVER MATCHES',
			startupTimeoutMs: 200,
		}

		it('a startup timeout reclaims the process group it spawned', async () => {
			const executor = makeExecutor()
			let pid: number | undefined
			executor.onStatusChanged = (_sessionId, _serviceType, status, details) => {
				if (status === 'starting') pid = details.pid
			}

			try {
				expect((await executor.start(neverReadyService, SessionId('s-timeout'))).ok).toBe(true)
				expect(pid).toBeDefined()

				await waitUntil(() => executor.getStatus('never-ready') === 'failed')
				expect(executor.getStatus('never-ready')).toBe('failed')

				// Ending the wait has to end the process too: a dev server left running here
				// keeps its several hundred MB and starves the next start of the memory it
				// needs to make its own window.
				await waitForDeath(pid!)
				expect(isAlive(pid!)).toBe(false)
			} finally {
				if (pid !== undefined) killGroup(pid)
				await executor.shutdown()
			}
		})

		it('starting over an entry that still owns a process reclaims the old one', async () => {
			// A paused service is alive under SIGSTOP. Starting it again overwrote the entry —
			// and the pid registry record, keyed by (session, type) — leaving nothing that
			// could ever find the process again.
			const executor = makeExecutor()
			const pausableService: ServiceConfig = {
				type: 'pausable',
				description: 'ready immediately, then paused',
				command: 'sleep 60',
			}
			const pids: number[] = []
			executor.onStatusChanged = (_sessionId, _serviceType, status, details) => {
				if (status === 'starting' && details.pid !== undefined) pids.push(details.pid)
			}

			try {
				expect((await executor.start(pausableService, SessionId('s-replace'))).ok).toBe(true)
				await waitUntil(() => executor.getStatus('pausable') === 'ready')
				expect((await executor.pause('pausable', SessionId('s-replace'))).ok).toBe(true)

				expect((await executor.start(pausableService, SessionId('s-replace'))).ok).toBe(true)
				expect(pids).toHaveLength(2)
				expect(pids[0]).not.toBe(pids[1])

				await waitForDeath(pids[0]!)
				expect(isAlive(pids[0]!)).toBe(false)
				expect(isAlive(pids[1]!)).toBe(true)
			} finally {
				for (const pid of pids) killGroup(pid)
				await executor.shutdown()
			}
		})

		it('stopping a failed service settles it instead of refusing', async () => {
			// The platform's reaper is the one caller that can free a leaked dev server's
			// memory; while stop() rejected everything but a running service, it could not.
			const executor = makeExecutor()
			let pid: number | undefined
			executor.onStatusChanged = (_sessionId, _serviceType, status, details) => {
				if (status === 'starting') pid = details.pid
			}

			try {
				expect((await executor.start(neverReadyService, SessionId('s-stop-failed'))).ok).toBe(true)
				await waitUntil(() => executor.getStatus('never-ready') === 'failed')

				const stopResult = await executor.stop('never-ready', SessionId('s-stop-failed'))
				expect(stopResult.ok).toBe(true)
				expect(executor.getStatus('never-ready')).toBe('stopped')
			} finally {
				if (pid !== undefined) killGroup(pid)
				await executor.shutdown()
			}
		})

		/**
		 * Replay what a previous server instance persists when a start times out: `failed`,
		 * still carrying the pid of a process it could not confirm gone. Both events are
		 * exactly what ServiceExecutor emits — the live process stands in for the dev server.
		 */
		async function seedFailedEntryOwningAProcess(
			eventStore: MemoryEventStore,
			sessionId: SessionId,
			pid: number,
			pidStartTime: number | undefined,
		): Promise<void> {
			for (const payload of [
				{ serviceType: 'quick', toStatus: 'starting' as const, port: 45_123, pid, pidStartTime },
				{
					serviceType: 'quick',
					toStatus: 'failed' as const,
					error: 'Service startup timed out after 30000ms',
					pid,
					pidStartTime,
				},
			]) {
				await eventStore.append(sessionId, withSessionId(sessionId, serviceEvents.create('service_status_changed', payload)))
			}
		}

		it('reclaims a failed entry a previous server instance left owning a process', async () => {
			const eventStore = new MemoryEventStore()
			const harness1 = new TestHarness({
				presets: [createServicesPreset([quickService], ['quick'], new PortPool())],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
				systemPlugins: [servicePlugin],
				eventStore,
			})
			const session1 = await harness1.createSession('test')
			await session1.sendAndWaitForIdle('Hi')
			const sessionId = session1.sessionId
			await harness1.sessionManager.shutdown()

			const orphanPid = spawnVictim()
			try {
				const fs = createNodePlatform().fs
				await seedFailedEntryOwningAProcess(eventStore, sessionId, orphanPid, await getProcessStartTime(fs, orphanPid))
				expect(isAlive(orphanPid)).toBe(true)

				// Fresh SessionManager over the same event store: opening the session fires
				// onSessionReady, whose reconcile used to look only at running statuses.
				const harness2 = new TestHarness({
					presets: [createServicesPreset([quickService], ['quick'], new PortPool())],
					llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
					systemPlugins: [servicePlugin],
					eventStore,
				})
				currentHarness = harness2
				const session2 = await harness2.openSession(sessionId)

				await waitForDeath(orphanPid)
				expect(isAlive(orphanPid)).toBe(false)

				// The failure stays a failure — reconciling only takes away its claim on a process.
				const entry = selectPluginState<Map<string, ServiceEntry>>(session2.state, 'services')?.get('quick')
				expect(entry?.status).toBe('failed')
				expect(entry?.error).toBe('Service startup timed out after 30000ms')
				expect(entry?.pid).toBeUndefined()
				expect(entry?.port).toBe(45_123)
			} finally {
				killGroup(orphanPid)
			}
		})

		it('refuses to reclaim a failed entry whose pid the kernel has recycled', async () => {
			const eventStore = new MemoryEventStore()
			const harness1 = new TestHarness({
				presets: [createServicesPreset([quickService], ['quick'], new PortPool())],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
				systemPlugins: [servicePlugin],
				eventStore,
			})
			const session1 = await harness1.createSession('test')
			await session1.sendAndWaitForIdle('Hi')
			const sessionId = session1.sessionId
			await harness1.sessionManager.shutdown()

			const bystanderPid = spawnVictim()
			try {
				const fs = createNodePlatform().fs
				const actualStartTime = await getProcessStartTime(fs, bystanderPid)
				expect(actualStartTime).toBeDefined()
				// Deliberately not the start time of the process now holding this pid: `failed`
				// does not imply a leaked process, and killing a recycled pid would be disastrous.
				await seedFailedEntryOwningAProcess(eventStore, sessionId, bystanderPid, actualStartTime! + 999)

				const harness2 = new TestHarness({
					presets: [createServicesPreset([quickService], ['quick'], new PortPool())],
					llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
					systemPlugins: [servicePlugin],
					eventStore,
				})
				currentHarness = harness2
				const session2 = await harness2.openSession(sessionId)

				expect(isAlive(bystanderPid)).toBe(true)

				// The entry still gives up its claim — whatever holds that pid now is not ours.
				const entry = selectPluginState<Map<string, ServiceEntry>>(session2.state, 'services')?.get('quick')
				expect(entry?.status).toBe('failed')
				expect(entry?.pid).toBeUndefined()
			} finally {
				killGroup(bystanderPid)
			}
		})

		it('reclaims an orphan that session_restarted had already marked stopped', async () => {
			// session_restarted fires just before onSessionReady and marks running services
			// stopped. It used to drop the pid with them, hiding the orphan from the very
			// reconcile that runs next — no status left to match, no pid left to kill.
			const eventStore = new MemoryEventStore()
			const harness1 = new TestHarness({
				presets: [createServicesPreset([quickService], ['quick'], new PortPool())],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
				systemPlugins: [servicePlugin],
				eventStore,
			})
			const session1 = await harness1.createSession('test')
			await session1.sendAndWaitForIdle('Hi')
			const sessionId = session1.sessionId
			await harness1.sessionManager.shutdown()

			const orphanPid = spawnVictim()
			try {
				const fs = createNodePlatform().fs
				await eventStore.append(
					sessionId,
					withSessionId(
						sessionId,
						serviceEvents.create('service_status_changed', {
							serviceType: 'quick',
							toStatus: 'starting',
							port: 45_124,
							pid: orphanPid,
							pidStartTime: await getProcessStartTime(fs, orphanPid),
						}),
					),
				)
				await eventStore.append(
					sessionId,
					withSessionId(sessionId, sessionEvents.create('session_restarted', { resetAgentIds: [], clearedToolAgentIds: [] })),
				)

				const harness2 = new TestHarness({
					presets: [createServicesPreset([quickService], ['quick'], new PortPool())],
					llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
					systemPlugins: [servicePlugin],
					eventStore,
				})
				currentHarness = harness2
				const session2 = await harness2.openSession(sessionId)

				await waitForDeath(orphanPid)
				expect(isAlive(orphanPid)).toBe(false)

				const entry = selectPluginState<Map<string, ServiceEntry>>(session2.state, 'services')?.get('quick')
				expect(entry?.status).toBe('stopped')
				expect(entry?.pid).toBeUndefined()
			} finally {
				killGroup(orphanPid)
			}
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
				await executor.shutdown()
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
				await executor.shutdown()
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
				await executor.shutdown()
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
				await executor.shutdown()
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
				await executor.shutdown()
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
				await executor.shutdown()
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
