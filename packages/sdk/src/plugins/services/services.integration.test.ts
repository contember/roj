import { afterEach, describe, expect, it } from 'bun:test'
import { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryEventStore } from '~/core/events/memory.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import { selectPluginState } from '~/core/sessions/reducer.js'
import { SessionId } from '~/core/sessions/schema.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { silentLogger } from '~/lib/logger/logger.js'
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
				await executor.shutdown()
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
				await executor.shutdown()
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
				await executor.shutdown()
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
				await executor.shutdown()
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
				await executor.shutdown()
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
				await executor.shutdown()
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

		it('closing a session stops a paused service through its lifecycle hook', async () => {
			const config: ServiceConfig = {
				type: 'paused-close',
				description: 'Paused process closed with its session',
				command: 'sleep 60',
				gracefulStopMs: 50,
			}
			const executorCreated = Promise.withResolvers<ServiceExecutor>()
			const stopObserving = setServiceExecutorObserverForTesting((executor) => executorCreated.resolve(executor))
			try {
				const harness = createServicesHarness({
					presets: [createServicesPreset([config], ['paused-close'], new PortPool())],
					llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
				})
				const session = await harness.createSession('test')
				const executor = await executorCreated.promise

				await session.callPluginMethod('services.start', { serviceType: 'paused-close' })
				await waitForServiceStateStatus(session, 'paused-close', 'ready')
				const paused = await executor.pause('paused-close', session.sessionId)
				expect(paused.ok).toBe(true)
				await waitForServiceStateStatus(session, 'paused-close', 'paused')
				const pid = selectPluginState<Map<string, ServiceEntry>>(session.state, 'services')?.get('paused-close')?.pid
				if (pid === undefined) throw new Error('Service did not report its pid')

				await session.close()
				await waitForServiceStateStatus(session, 'paused-close', 'stopped')
				expect(() => process.kill(pid, 0)).toThrow()
			} finally {
				stopObserving()
			}
		})

		it('restarting a paused service replaces its process', async () => {
			const config: ServiceConfig = {
				type: 'paused-restart',
				description: 'Paused process restarted through the plugin method',
				command: 'sleep 60',
				gracefulStopMs: 50,
			}
			const executorCreated = Promise.withResolvers<ServiceExecutor>()
			const stopObserving = setServiceExecutorObserverForTesting((executor) => executorCreated.resolve(executor))
			try {
				const harness = createServicesHarness({
					presets: [createServicesPreset([config], ['paused-restart'], new PortPool())],
					llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
				})
				const session = await harness.createSession('test')
				const executor = await executorCreated.promise

				await session.callPluginMethod('services.start', { serviceType: 'paused-restart' })
				await waitForServiceStateStatus(session, 'paused-restart', 'ready')
				const originalPid = selectPluginState<Map<string, ServiceEntry>>(session.state, 'services')?.get('paused-restart')?.pid
				if (originalPid === undefined) throw new Error('Service did not report its pid')
				const paused = await executor.pause('paused-restart', session.sessionId)
				expect(paused.ok).toBe(true)
				await waitForServiceStateStatus(session, 'paused-restart', 'paused')

				const restarted = await session.callPluginMethod('services.restart', { serviceType: 'paused-restart' })
				expect(restarted.ok).toBe(true)
				await waitForServiceStateStatus(session, 'paused-restart', 'ready')
				const replacementPid = selectPluginState<Map<string, ServiceEntry>>(session.state, 'services')?.get('paused-restart')?.pid
				expect(replacementPid).toBeDefined()
				expect(replacementPid).not.toBe(originalPid)
				expect(() => process.kill(originalPid, 0)).toThrow()
			} finally {
				stopObserving()
			}
		})

		it('an externally killed paused service transitions to failed', async () => {
			const platform = createNodePlatform()
			const executor = new ServiceExecutor(silentLogger, new PortPool(), { fs: platform.fs, process: platform.process })
			const config: ServiceConfig = {
				type: 'paused-crash',
				description: 'Paused process killed externally',
				command: 'sleep 60',
			}
			let pid: number | undefined
			executor.onStatusChanged = (_sessionId, _serviceType, status, details) => {
				if (status === 'starting') pid = details.pid
			}

			try {
				await executor.start(config, SessionId('s-paused-crash'))
				const paused = await executor.pause('paused-crash', SessionId('s-paused-crash'))
				expect(paused.ok).toBe(true)
				if (pid === undefined) throw new Error('Service did not report its pid')
				process.kill(-pid, 'SIGKILL')
				await waitFor(
					() => executor.getStatus('paused-crash') === 'failed',
					() => String(executor.getStatus('paused-crash')),
				)
			} finally {
				await executor.shutdown()
			}
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
				await executor.shutdown()
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
				await executor.shutdown()
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
				await executor.shutdown()
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
			await executor.shutdown()
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
			await executor.shutdown()
		})

		it('a failed shutdown retries entries already marked stopping', async () => {
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
			let permissionDenied = true
			const platform = createNodePlatform()
			const executor = new ServiceExecutor(silentLogger, new PortPool(), {
				fs: platform.fs,
				process: processRunner,
				kill: () => {
					throw systemError(permissionDenied ? 'EPERM' : 'ESRCH')
				},
			})
			await executor.start({
				type: 'retryable-shutdown',
				description: 'Shutdown retries stopping entries',
				command: 'unused',
			}, SessionId('s-retryable-shutdown'))

			await expect(executor.shutdown()).rejects.toThrow('SIGTERM')
			expect(executor.getStatus('retryable-shutdown')).toBe('stopping')
			permissionDenied = false
			await executor.shutdown()
			expect(executor.getStatus('retryable-shutdown')).toBeNull()
		})

		const exerciseTermination = async (mode: 'stop' | 'shutdown'): Promise<void> => {
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
					await executor.shutdown()
				}

				expect(await isPidTerminated(childPid)).toBe(true)
				expect(await isPidTerminated(grandchildPid)).toBe(true)
			} finally {
				await executor.shutdown()
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

		it('shutdown waits for child and grandchild processes after the leader exits', async () => {
			await exerciseTermination('shutdown')
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
