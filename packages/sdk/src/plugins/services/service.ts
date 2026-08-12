/**
 * ServiceExecutor - Manages child processes for session services.
 *
 * Each service type has at most one running instance per session.
 * Services are long-running background processes (e.g., dev servers).
 * Ports are allocated from a global PortPool and injected via PORT env var.
 */

import { resolve } from 'node:path'
import type { SessionId } from '~/core/sessions/schema.js'
import type { Result } from '~/lib/utils/result.js'
import { Err, Ok } from '~/lib/utils/result.js'
import type { FileSystem } from '~/platform/fs.js'
import type { ChildProcess, ProcessRunner } from '~/platform/process.js'
import type { PortPool } from '~/plugins/services/port-pool.js'
import type { ServicePidRegistry } from '~/plugins/services/pid-registry.js'
import type { ServiceConfig, ServiceStartArgs, ServiceStatus } from '~/plugins/services/schema.js'
import type { ToolError } from '../../core/tools/executor.js'
import type { Logger } from '../../lib/logger/logger.js'
import { RingBuffer } from '../../lib/logger/ring-buffer.js'

// ============================================================================
// PID start-time helper (Linux only)
// ============================================================================

/**
 * Read a process's start time from /proc/<pid>/stat field 22 (starttime in clock
 * ticks since boot). Used to detect PID reuse: a captured value paired with a PID
 * uniquely identifies a process, since the kernel guarantees start time is
 * monotonic within a boot. Returns undefined on non-Linux, if the process is
 * gone, or on parse failure — callers must treat undefined as "unknown, don't
 * rely on it" rather than "process is dead".
 */
export async function getProcessStartTime(fs: FileSystem, pid: number): Promise<number | undefined> {
	try {
		const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf-8')
		// Field 2 (comm) is wrapped in parens and may itself contain spaces or
		// parens, so we anchor on the LAST ')' and split the remainder on spaces.
		// After the comm field, fields resume at index 0 = field 3 (state), so
		// field 22 (starttime) lives at index 19.
		const rparen = stat.lastIndexOf(')')
		if (rparen === -1) return undefined
		const fields = stat.slice(rparen + 2).split(' ')
		const starttime = Number(fields[19])
		return Number.isFinite(starttime) ? starttime : undefined
	} catch {
		return undefined
	}
}

// ============================================================================
// Types
// ============================================================================

interface RunningService {
	config: ServiceConfig
	process: ChildProcess
	pid: number
	status: ServiceStatus
	port: number
	cwd?: string
	command: string
	logs: RingBuffer
	forgetPid: () => Promise<void>
}

export interface ServiceStatusChangeDetails {
	port?: number
	error?: string
	pid?: number
	pidStartTime?: number
	cwd?: string
	command?: string
	/** Set on a `failed` change that already has a revival queued — see ServiceEntry.restartAt. */
	restartAt?: number
	restartAttempt?: number
	restartMaxRetries?: number
}

/** A revival the policy has queued, as reported on the `failed` status change. */
interface ScheduledRestart {
	restartAt: number
	restartAttempt: number
	restartMaxRetries: number
}

/** Matches a port bind-conflict across the Node and Bun runtimes. */
const PORT_CONFLICT_PATTERN = /EADDRINUSE|address already in use/i

/**
 * How many times {@link ServiceExecutor.start} will silently re-allocate a fresh
 * port and retry when the chosen port is already held by a foreign process
 * (EADDRINUSE). Bounded so a service that is genuinely unstartable still ends up
 * `failed` instead of looping forever.
 */
const MAX_PORT_CONFLICT_RETRIES = 3

/** `restartPolicy` defaults — see ServiceConfig.restartPolicy for the rationale. */
const DEFAULT_MAX_RESTART_RETRIES = 3
const DEFAULT_RESTART_DELAY_MS = 1000
const DEFAULT_MAX_RESTART_DELAY_MS = 30_000
const DEFAULT_RESTART_HEALTHY_AFTER_MS = 60_000

// ============================================================================
// ServiceExecutor
// ============================================================================

export interface ServiceExecutorDeps {
	fs: FileSystem
	process: ProcessRunner
	/** Durable pid record, swept at agent boot. Optional so embedders without a data dir still work. */
	pidRegistry?: Pick<ServicePidRegistry, 'record' | 'forget'>
	/** Test seam for process-group failure handling. */
	kill?: typeof process.kill
}

type ProcessGroupProbe = { state: 'alive' | 'gone' } | { state: 'error'; error: Error }

let serviceExecutorObserverForTesting: ((executor: ServiceExecutor) => void) | undefined

/** Observe executor creation in integration tests without exposing lifecycle methods as plugin API. */
export function setServiceExecutorObserverForTesting(observer: (executor: ServiceExecutor) => void): () => void {
	const previous = serviceExecutorObserverForTesting
	serviceExecutorObserverForTesting = observer
	return () => {
		if (serviceExecutorObserverForTesting === observer) serviceExecutorObserverForTesting = previous
	}
}

export class ServiceExecutor {
	private readonly services = new Map<string, RunningService>()
	private readonly allocatedPorts = new Map<string, number>()
	private readonly waiters = new Map<string, Array<{ resolve: (result: Result<void, ToolError>) => void; timer: ReturnType<typeof setTimeout> }>>()
	/** Per-type lock collapsing concurrent start() calls onto a single in-flight start. */
	private readonly startInFlight = new Map<string, Promise<Result<void, ToolError>>>()
	/** Registry deletions that must settle before a replacement can record its PID. */
	private readonly pidForgets = new Map<string, Promise<void>>()
	/** Per-type counter bounding automatic EADDRINUSE port re-allocation retries. */
	private readonly portConflictRetries = new Map<string, number>()
	/** Per-type counter bounding `restartPolicy` revivals after an unexpected exit. */
	private readonly restartRetries = new Map<string, number>()
	/** Pending `restartPolicy` timers, cancelled when someone stops or starts the service by hand. */
	private readonly restartTimers = new Map<string, ReturnType<typeof setTimeout>>()
	private readonly logger: Logger
	private readonly portPool: PortPool
	private readonly fs: FileSystem
	private readonly processRunner: ProcessRunner
	private readonly pidRegistry?: Pick<ServicePidRegistry, 'record' | 'forget'>
	private readonly killProcess: typeof process.kill

	/** Optional callback invoked on every service status change */
	onStatusChanged?: (
		sessionId: string,
		serviceType: string,
		status: ServiceStatus,
		details: ServiceStatusChangeDetails,
	) => void

	constructor(logger: Logger, portPool: PortPool, deps: ServiceExecutorDeps) {
		this.logger = logger
		this.portPool = portPool
		this.fs = deps.fs
		this.processRunner = deps.process
		this.pidRegistry = deps.pidRegistry
		this.killProcess = deps.kill ?? process.kill
		serviceExecutorObserverForTesting?.(this)
	}

	private notifyStatusChanged(
		sessionId: string,
		serviceType: string,
		status: ServiceStatus,
		details: ServiceStatusChangeDetails = {},
	): void {
		this.onStatusChanged?.(sessionId, serviceType, status, details)
		if (status === 'ready' || status === 'failed' || status === 'stopped') {
			this.resolveWaiters(serviceType, status, details.error)
		}
	}

	private async isAvailable(config: ServiceConfig, sessionId: SessionId, workspaceDir?: string): Promise<Result<boolean, ToolError>> {
		if (!config.availableWhen) return Ok(true)

		try {
			return Ok(await config.availableWhen({ sessionId: String(sessionId), workspaceDir }))
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			return Err({ message: `Service '${config.type}' availability check failed: ${message}`, recoverable: true })
		}
	}

	private async resolveCwd(config: ServiceConfig, sessionId: SessionId, workspaceDir?: string): Promise<Result<string | undefined, ToolError>> {
		try {
			if (typeof config.cwd === 'function') {
				if (!workspaceDir) {
					return Err({
						message: `Service '${config.type}' cwd resolver requires a workspaceDir`,
						recoverable: true,
					})
				}
				const raw = await config.cwd({ sessionId: String(sessionId), workspaceDir })
				return Ok(resolve(workspaceDir, raw))
			}

			if (config.cwd !== undefined) {
				return Ok(workspaceDir ? resolve(workspaceDir, config.cwd) : resolve(config.cwd))
			}

			return Ok(workspaceDir)
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			return Err({ message: `Service '${config.type}' cwd resolver failed: ${message}`, recoverable: true })
		}
	}

	private resolveWaiters(serviceType: string, status: ServiceStatus, error?: string): void {
		const pending = this.waiters.get(serviceType)
		if (!pending || pending.length === 0) return
		this.waiters.delete(serviceType)

		const result: Result<void, ToolError> = status === 'ready'
			? Ok(undefined)
			: Err({ message: error ?? `Service '${serviceType}' ${status}`, recoverable: true })

		for (const waiter of pending) {
			clearTimeout(waiter.timer)
			waiter.resolve(result)
		}
	}

	/**
	 * Wait for a service to reach a terminal status (ready, failed, or stopped).
	 * Returns immediately if the service is already in a terminal status.
	 */
	waitForReady(serviceType: string, timeoutMs = 60_000): Promise<Result<void, ToolError>> {
		const status = this.getStatus(serviceType)
		if (status === 'ready') return Promise.resolve(Ok(undefined))
		if (status === 'failed' || status === 'stopped') {
			const entry = this.services.get(serviceType)
			return Promise.resolve(
				Err({ message: entry?.config.type ? `Service '${serviceType}' is ${status}` : `Service '${serviceType}' not found`, recoverable: true }),
			)
		}

		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				const pending = this.waiters.get(serviceType)
				if (pending) {
					const idx = pending.findIndex((w) => w.resolve === resolve)
					if (idx !== -1) pending.splice(idx, 1)
					if (pending.length === 0) this.waiters.delete(serviceType)
				}
				resolve(Err({ message: `Timed out waiting for service '${serviceType}' to become ready`, recoverable: true }))
			}, timeoutMs)

			const pending = this.waiters.get(serviceType) ?? []
			pending.push({ resolve, timer })
			this.waiters.set(serviceType, pending)
		})
	}

	/**
	 * Start a service. Idempotent — returns Ok if already running or starting.
	 *
	 * Concurrent calls for the same service type are collapsed onto a single
	 * in-flight start. The executor mutates its per-type state (`services` /
	 * `allocatedPorts`) only between awaits, so without this guard two overlapping
	 * starts could both pass the "already running" check and spawn two processes
	 * on the same allocated port: one wins the port, the other dies with
	 * EADDRINUSE, and — because state is keyed by service type — the loser's
	 * `failed` event overwrites the winner's `ready`, leaving a healthy-but-
	 * untracked listener while the control plane believes the service failed.
	 * Deduping here guarantees exactly one process per type.
	 */
	async start(
		config: ServiceConfig,
		sessionId: SessionId,
		workspaceDir?: string,
		preferredPort?: number,
	): Promise<Result<void, ToolError>> {
		const inFlight = this.startInFlight.get(config.type)
		if (inFlight) return inFlight

		const promise = this.startInternal(config, sessionId, workspaceDir, preferredPort)
		this.startInFlight.set(config.type, promise)
		try {
			return await promise
		} finally {
			this.startInFlight.delete(config.type)
		}
	}

	private async startInternal(
		config: ServiceConfig,
		sessionId: SessionId,
		workspaceDir?: string,
		preferredPort?: number,
	): Promise<Result<void, ToolError>> {
		// This start supersedes any revival the policy had queued.
		this.cancelPendingRestart(config.type)

		const existing = this.services.get(config.type)
		if (existing && (existing.status === 'starting' || existing.status === 'ready' || existing.status === 'paused')) {
			return Ok(undefined)
		}
		if (existing?.status === 'stopping') {
			return Err({ message: `Service '${config.type}' is stopping, cannot start`, recoverable: true })
		}
		if (existing) await existing.forgetPid()
		await this.pidForgets.get(config.type)

		const availability = await this.isAvailable(config, sessionId, workspaceDir)
		if (!availability.ok) return availability
		if (!availability.value) {
			return Err({ message: `Service '${config.type}' is not available in this workspace`, recoverable: true })
		}

		// Allocate port: reuse session-level allocation, then try preferred, then random
		let port = this.allocatedPorts.get(config.type)
		let allocatedNow = false
		if (port === undefined) {
			port = this.portPool.allocatePreferred(preferredPort) ?? undefined
			if (port === undefined) {
				this.notifyStatusChanged(sessionId, config.type, 'failed', { error: 'No ports available in pool' })
				return Err({ message: 'No ports available in pool', recoverable: true })
			}
			this.allocatedPorts.set(config.type, port)
			allocatedNow = true
		}

		const cwdResult = await this.resolveCwd(config, sessionId, workspaceDir)
		if (!cwdResult.ok) {
			if (allocatedNow) {
				this.allocatedPorts.delete(config.type)
				this.portPool.release(port)
			}
			this.notifyStatusChanged(sessionId, config.type, 'failed', { port, error: cwdResult.error.message })
			return cwdResult
		}

		const cwd = cwdResult.value
		const logBufferSize = Math.max(1, config.logBufferSize ?? 200)
		const startupTimeoutMs = config.startupTimeoutMs ?? 30_000

		const readyRegex = config.readyPattern ? new RegExp(config.readyPattern) : undefined
		const logs = new RingBuffer(logBufferSize)
		const maxDiagnosticLength = 16_384
		const startTime = Date.now()
		let portConflictDetected = false
		let setupComplete = false
		let retryPortConflictDuringSetup = false
		let readyDetectedDuringSetup = false
		let readyLineDuringSetup: string | undefined
		let stdoutPartial = ''
		let stderrPartial = ''
		let outputSequence = 0
		let stdoutPartialSequence = 0
		let stderrPartialSequence = 0

		const startArgs = {
			port,
			sessionId: String(sessionId),
			workspaceDir,
			cwd,
		}

		let command: string
		let serviceEnv: Record<string, string> | undefined
		try {
			command = typeof config.command === 'function'
				? await config.command(startArgs)
				: config.command
			serviceEnv = typeof config.env === 'function'
				? await config.env(startArgs)
				: config.env
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			const errorMessage = `Service '${config.type}' start resolver failed: ${message}`
			if (allocatedNow) {
				this.allocatedPorts.delete(config.type)
				this.portPool.release(port)
			}
			this.notifyStatusChanged(sessionId, config.type, 'failed', { port, cwd, error: errorMessage })
			return Err({ message: errorMessage, recoverable: true })
		}

		const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
		const shellFlag = process.platform === 'win32' ? '/c' : '-c'

		const child = this.processRunner.spawn(shell, [shellFlag, command], {
			cwd,
			env: { ...process.env, ...serviceEnv, PORT: String(port) },
			detached: true,
			stdio: ['ignore', 'pipe', 'pipe'],
		})

		// Must register error handler immediately — Bun emits ENOENT as async
		// error event (not synchronous throw). Without handler it crashes the process.
		child.on('error', (error) => {
			this.logger.error('Service process error', error, { serviceType: config.type })
			const current = this.services.get(config.type)
			if (current && current.process === child && current.status !== 'stopped' && current.status !== 'failed') {
				current.status = 'failed'
				this.notifyStatusChanged(sessionId, config.type, 'failed', {
					error: error.message,
					cwd,
					command,
				})
			}
		})

		if (!child.pid) {
			if (allocatedNow) {
				this.allocatedPorts.delete(config.type)
				this.portPool.release(port)
			}
			this.notifyStatusChanged(sessionId, config.type, 'failed', { port, cwd, command, error: 'Failed to spawn process' })
			return Err({ message: 'Failed to spawn service process', recoverable: true })
		}

		const matches = (regex: RegExp, content: string): boolean => {
			regex.lastIndex = 0
			const matched = regex.test(content)
			regex.lastIndex = 0
			return matched
		}

		const recordDiagnostic = (line: string, prefix: string) => {
			const maxContentLength = Math.max(0, maxDiagnosticLength - prefix.length)
			const bounded = line.length > maxContentLength ? line.slice(-maxContentLength) : line
			logs.push(`${prefix}${bounded}`)
		}

		// Detection sees the full incoming content before diagnostics are truncated.
		const appendOutput = (partial: string, data: Buffer, prefix: string): string => {
			const combined = partial + data.toString()
			if (matches(PORT_CONFLICT_PATTERN, combined)) portConflictDetected = true
			const lines = combined.split('\n')
			const nextPartial = lines.pop() ?? ''
			const readyMatched = readyRegex ? matches(readyRegex, combined) || lines.some((line) => matches(readyRegex, line)) : false
			if (readyMatched && !setupComplete) {
				readyDetectedDuringSetup = true
				readyLineDuringSetup = combined.slice(-maxDiagnosticLength)
			}

			for (const line of lines) recordDiagnostic(line, prefix)

			if (setupComplete) {
				const current = this.services.get(config.type)
				if (current?.process === child && current.status === 'starting') {
					this.logger.debug('Service output', { serviceType: config.type })
					if (readyMatched) markReady(combined.slice(-maxDiagnosticLength))
				}
				void checkReadyWhen()
			}

			// Retain enough suffix for markers split across chunks, never an entire line.
			return nextPartial.length > maxDiagnosticLength ? nextPartial.slice(-maxDiagnosticLength) : nextPartial
		}

		const onStdout = (data: Buffer) => {
			stdoutPartial = appendOutput(stdoutPartial, data, '')
			stdoutPartialSequence = stdoutPartial ? ++outputSequence : 0
		}
		const onStderr = (data: Buffer) => {
			stderrPartial = appendOutput(stderrPartial, data, '[stderr] ')
			stderrPartialSequence = stderrPartial ? ++outputSequence : 0
		}

		let exitDuringSetup: { code: number | null } | undefined
		let forgetPromise: Promise<void> | undefined
		const forgetPid = (): Promise<void> => {
			if (forgetPromise) return forgetPromise
			const previous = this.pidForgets.get(config.type)
			const runForget = () => this.pidRegistry?.forget(String(sessionId), config.type) ?? Promise.resolve()
			const operation = previous ? previous.then(runForget, runForget) : runForget()
			forgetPromise = operation
			this.pidForgets.set(config.type, operation)
			void operation.then(
				() => {
					if (this.pidForgets.get(config.type) === operation) this.pidForgets.delete(config.type)
				},
				() => {
					if (this.pidForgets.get(config.type) === operation) this.pidForgets.delete(config.type)
					if (forgetPromise === operation) forgetPromise = undefined
				},
			)
			return operation
		}
		const bufferClose = (code: number | null) => {
			exitDuringSetup = { code }
		}
		child.stdout?.on('data', onStdout)
		child.stderr?.on('data', onStderr)
		child.on('close', bufferClose)

		// Capture start time immediately so a later PID-reuse check can distinguish
		// "our process" from "an unrelated process that grabbed this PID after ours died"
		const pidStartTime = await getProcessStartTime(this.fs, child.pid)

		// Durably record the process so a future agent can reap it if we die before the
		// `close` handler gets to forget it. The session projection cannot serve that
		// purpose — see ServicePidRegistry.
		await this.pidRegistry?.record({ sessionId: String(sessionId), serviceType: config.type, pid: child.pid, pidStartTime, command })

		// Emit starting event with PID, port, resolved cwd/command, and start time.
		this.notifyStatusChanged(sessionId, config.type, 'starting', { port, pid: child.pid, pidStartTime, cwd, command })

		const entry: RunningService = {
			config,
			process: child,
			pid: child.pid,
			status: 'starting',
			port,
			cwd,
			command,
			logs,
			forgetPid,
		}
		this.services.set(config.type, entry)

		let startupTimer: ReturnType<typeof setTimeout> | undefined
		let readyCheckTimer: ReturnType<typeof setInterval> | undefined
		let readyCheckInFlight = false

		const clearReadinessTimers = () => {
			if (startupTimer) {
				clearTimeout(startupTimer)
				startupTimer = undefined
			}
			if (readyCheckTimer) {
				clearInterval(readyCheckTimer)
				readyCheckTimer = undefined
			}
		}

		const markReady = (matchedLine?: string) => {
			const current = this.services.get(config.type)
			if (!current || current.process !== child || current.status !== 'starting') return

			current.status = 'ready'
			clearReadinessTimers()
			this.portConflictRetries.delete(config.type)
			const startupDurationMs = Date.now() - startTime
			this.notifyStatusChanged(sessionId, config.type, 'ready', {
				port: current.port,
				cwd: current.cwd,
				command: current.command,
			})
			this.logger.info('Service ready', {
				serviceType: config.type,
				port: current.port,
				startupDurationMs,
				matchedLine,
			})
		}

		const readyArgs = (): ServiceStartArgs => ({
			...startArgs,
			logs: logs.toArray(),
		})

		const checkReadyWhen = async () => {
			if (!config.readyWhen || readyCheckInFlight) return
			const current = this.services.get(config.type)
			if (!current || current.process !== child || current.status !== 'starting') return

			readyCheckInFlight = true
			try {
				if (await config.readyWhen(readyArgs())) {
					markReady()
				}
			} catch {
				// The service may not be reachable yet; keep polling until timeout.
			} finally {
				readyCheckInFlight = false
			}
		}

		// Startup timeout — mark as failed if not ready in time
		if (readyRegex || config.readyWhen) {
			startupTimer = setTimeout(() => {
				const current = this.services.get(config.type)
				if (!current || current.process !== child || current.status !== 'starting') return

				current.status = 'failed'
				const errorMsg = `Service startup timed out after ${startupTimeoutMs}ms`
				this.logger.error(errorMsg, undefined, { serviceType: config.type })
				clearReadinessTimers()
				this.notifyStatusChanged(sessionId, config.type, 'failed', {
					port: current.port,
					cwd: current.cwd,
					command: current.command,
					error: errorMsg,
				})

				// Kill the timed-out process
				try {
					process.kill(-current.pid, 'SIGKILL')
				} catch {
					// Already gone
				}
			}, startupTimeoutMs)
		}

		if (config.readyWhen) {
			const intervalMs = config.readyCheckIntervalMs ?? 250
			readyCheckTimer = setInterval(() => {
				void checkReadyWhen()
			}, intervalMs)
		}

		// Handle unexpected exit. Named and guarded because it also has to be
		// replayable — see the exit-during-setup check after markReady() below.
		let closeHandled = false
		const handleClose = (code: number | null) => {
			if (closeHandled) return
			closeHandled = true
			clearReadinessTimers()
			// A replacement must not be recorded until this deletion finishes.
			void forgetPid()
			const partials = [
				{ content: stdoutPartial, prefix: '', sequence: stdoutPartialSequence },
				{ content: stderrPartial, prefix: '[stderr] ', sequence: stderrPartialSequence },
			]
			for (const partial of partials.filter(({ content }) => content).sort((left, right) => left.sequence - right.sequence)) {
				recordDiagnostic(partial.content, partial.prefix)
			}
			stdoutPartial = ''
			stderrPartial = ''

			const current = this.services.get(config.type)
			if (!current || current.process !== child) return

			if (current.status === 'stopping') {
				// Expected stop
				current.status = 'stopped'
				this.notifyStatusChanged(sessionId, config.type, 'stopped')
			} else if (current.status === 'starting' || current.status === 'ready' || current.status === 'paused') {
				const retries = this.portConflictRetries.get(config.type) ?? 0
				if (current.status === 'starting' && portConflictDetected && retries < MAX_PORT_CONFLICT_RETRIES) {
					// The chosen port is held by a foreign process (e.g. a service
					// leaked from another session, or a survivor of a previous boot).
					// Re-allocate a fresh port and retry so the service recovers on a
					// different port instead of wedging on the occupied one. The
					// conflicted port stays reserved in the pool — it is physically in
					// use, so releasing it would let a later allocation hand it out and
					// collide again — while we drop only our type→port pin so the retry
					// picks a new one.
					this.portConflictRetries.set(config.type, retries + 1)
					this.logger.warn('Service port in use — re-allocating to a fresh port', {
						serviceType: config.type,
						conflictedPort: current.port,
						attempt: retries + 1,
					})
					this.allocatedPorts.delete(config.type)
					this.services.delete(config.type)
					if (!setupComplete) {
						retryPortConflictDuringSetup = true
					} else {
						setTimeout(() => void this.start(config, sessionId, workspaceDir), 0)
					}
					return
				}

				// Unexpected exit
				current.status = 'failed'
				const errorMsg = `Process exited unexpectedly with code ${code}`
				this.portConflictRetries.delete(config.type)
				// Queue the revival first so the `failed` change can carry it — a
				// consumer that sees a bare `failed` is entitled to treat it as terminal.
				const revival = this.scheduleRestart(config, sessionId, workspaceDir, Date.now() - startTime, code)
				this.notifyStatusChanged(sessionId, config.type, 'failed', {
					port: current.port,
					cwd: current.cwd,
					command: current.command,
					error: errorMsg,
					...revival,
				})
				this.logger.warn('Service process exited unexpectedly', {
					serviceType: config.type,
					code,
				})
			}
		}
		child.on('close', handleClose)
		child.off('close', bufferClose)

		this.logger.info('Service starting', {
			serviceType: config.type,
			pid: child.pid,
			port,
			command,
			cwd,
			readyPattern: config.readyPattern,
			startupTimeoutMs,
		})

		// A service that died inside the bookkeeping above closed while only the
		// setup close collector was listening, so replay that close now.
		// `alreadyReaped` covers the in-between state: the exit is recorded but
		// 'close' has not fired yet because it waits for the stdio EOF. The listener
		// above is guaranteed to receive it, so calling handleClose here would only
		// drop the tail of the log the failure has to explain — while marking such a
		// child ready would be a lie.
		const alreadyReaped = child.exitCode != null || child.signalCode != null
		if (exitDuringSetup) {
			handleClose(exitDuringSetup.code)
		}

		setupComplete = true
		if (retryPortConflictDuringSetup) {
			await forgetPid()
			return this.startInternal(config, sessionId, workspaceDir)
		}
		if (exitDuringSetup || alreadyReaped) {
			return Ok(undefined)
		}
		if (readyDetectedDuringSetup) {
			markReady(readyLineDuringSetup)
		} else if (!readyRegex && !config.readyWhen) {
			// If no ready condition is configured, a live child is ready immediately.
			markReady()
		} else if (config.readyWhen) {
			void checkReadyWhen()
		}

		return Ok(undefined)
	}

	/**
	 * Bring a crashed service back if its `restartPolicy` allows it. The port
	 * allocation is kept on purpose — the preview URL has to survive the bounce.
	 *
	 * Returns the queued revival so the caller can put it on the `failed` status
	 * change, or undefined when the service is left failed for good.
	 */
	private scheduleRestart(
		config: ServiceConfig,
		sessionId: SessionId,
		workspaceDir: string | undefined,
		uptimeMs: number,
		exitCode: number | null,
	): ScheduledRestart | undefined {
		const policy = config.restartPolicy
		if (!policy) return undefined

		// A service that ran for a while and then died is a new problem, not the
		// continuation of a boot loop — give it a full budget again.
		if (uptimeMs >= (policy.healthyAfterMs ?? DEFAULT_RESTART_HEALTHY_AFTER_MS)) {
			this.restartRetries.delete(config.type)
		}

		const attempt = this.restartRetries.get(config.type) ?? 0
		const maxRetries = policy.maxRetries ?? DEFAULT_MAX_RESTART_RETRIES
		if (attempt >= maxRetries) {
			this.logger.warn('Service left failed — automatic restart budget spent', {
				serviceType: config.type,
				attempts: attempt,
				exitCode,
			})
			this.restartRetries.delete(config.type)
			return undefined
		}

		const initialDelayMs = policy.initialDelayMs ?? DEFAULT_RESTART_DELAY_MS
		const delayMs = Math.min(initialDelayMs * 2 ** attempt, policy.maxDelayMs ?? DEFAULT_MAX_RESTART_DELAY_MS)
		this.restartRetries.set(config.type, attempt + 1)
		this.logger.info('Restarting service after unexpected exit', {
			serviceType: config.type,
			attempt: attempt + 1,
			maxRetries,
			delayMs,
			exitCode,
		})

		const timer = setTimeout(() => {
			this.restartTimers.delete(config.type)
			void this.start(config, sessionId, workspaceDir)
		}, delayMs)
		// A pending revival must not keep the process alive on its own.
		timer.unref?.()
		this.restartTimers.set(config.type, timer)

		return { restartAt: Date.now() + delayMs, restartAttempt: attempt + 1, restartMaxRetries: maxRetries }
	}

	/** Drop a pending automatic restart — an explicit start or stop wins over it. Returns true if one was queued. */
	private cancelPendingRestart(serviceType: string): boolean {
		const timer = this.restartTimers.get(serviceType)
		if (!timer) return false
		clearTimeout(timer)
		this.restartTimers.delete(serviceType)
		return true
	}

	/** Whether a `restartPolicy` revival is queued — the service is down but coming back. */
	hasScheduledRestart(serviceType: string): boolean {
		return this.restartTimers.has(serviceType)
	}

	private errorWithContext(error: unknown, context: string): Error {
		const cause = error instanceof Error ? error.message : String(error)
		return new Error(`${context}: ${cause}`)
	}

	private hasErrorCode(error: unknown, code: string): boolean {
		return error instanceof Error && 'code' in error && error.code === code
	}

	private async hasNonZombieProcessGroupMember(pid: number): Promise<boolean> {
		if (process.platform !== 'linux') return true

		let entries: string[]
		try {
			entries = await this.fs.readdir('/proc')
		} catch {
			return true
		}

		let foundGroupMember = false
		for (const entry of entries) {
			if (!/^\d+$/.test(entry)) continue
			try {
				const stat = await this.fs.readFile(`/proc/${entry}/stat`, 'utf-8')
				const rparen = stat.lastIndexOf(')')
				if (rparen === -1) continue
				const fields = stat.slice(rparen + 2).split(' ')
				if (Number(fields[2]) !== pid) continue
				foundGroupMember = true
				if (fields[0] !== 'Z') return true
			} catch {
				// Processes can disappear while /proc is scanned.
			}
		}
		// A successful group probe with no readable member is still evidence of life.
		return !foundGroupMember
	}

	private async probeProcessGroup(pid: number): Promise<ProcessGroupProbe> {
		try {
			this.killProcess(-pid, 0)
		} catch (error) {
			if (this.hasErrorCode(error, 'ESRCH')) return { state: 'gone' }
			if (this.hasErrorCode(error, 'EPERM')) return { state: 'alive' }
			return { state: 'error', error: this.errorWithContext(error, `Failed to probe process group ${pid}`) }
		}

		return await this.hasNonZombieProcessGroupMember(pid) ? { state: 'alive' } : { state: 'gone' }
	}

	private async signalProcessGroup(pid: number, signal: NodeJS.Signals): Promise<ProcessGroupProbe> {
		try {
			this.killProcess(-pid, signal)
			return { state: 'alive' }
		} catch (error) {
			if (this.hasErrorCode(error, 'ESRCH')) return { state: 'gone' }
			return { state: 'error', error: this.errorWithContext(error, `Failed to send ${signal} to process group ${pid}`) }
		}
	}

	private async waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<ProcessGroupProbe> {
		const initial = await this.probeProcessGroup(pid)
		if (initial.state !== 'alive') return initial

		return new Promise((resolve) => {
			let settled = false
			const finish = (result: ProcessGroupProbe) => {
				if (settled) return
				settled = true
				clearInterval(checkInterval)
				clearTimeout(timeout)
				resolve(result)
			}
			const checkInterval = setInterval(() => {
				void this.probeProcessGroup(pid).then((result) => {
					if (result.state !== 'alive') finish(result)
				})
			}, 50)
			const timeout = setTimeout(() => {
				void this.probeProcessGroup(pid).then(finish)
			}, timeoutMs)
		})
	}

	private async terminateProcessGroup(pid: number, gracefulStopMs: number): Promise<Result<void, Error>> {
		const initial = await this.probeProcessGroup(pid)
		if (initial.state === 'gone') return Ok(undefined)
		if (initial.state === 'error') return Err(initial.error)

		const term = await this.signalProcessGroup(pid, 'SIGTERM')
		if (term.state === 'gone') return Ok(undefined)
		if (term.state === 'error') return Err(term.error)
		const graceful = await this.waitForProcessGroupExit(pid, gracefulStopMs)
		if (graceful.state === 'gone') return Ok(undefined)
		if (graceful.state === 'error') return Err(graceful.error)

		const kill = await this.signalProcessGroup(pid, 'SIGKILL')
		if (kill.state === 'gone') return Ok(undefined)
		if (kill.state === 'error') return Err(kill.error)
		const forced = await this.waitForProcessGroupExit(pid, 5000)
		if (forced.state === 'gone') return Ok(undefined)
		if (forced.state === 'error') return Err(forced.error)
		return Err(new Error(`Process group ${pid} survived SIGKILL`))
	}

	/**
	 * Stop a running service gracefully.
	 * Port is NOT released — kept for session-level stability across restarts.
	 */
	async stop(serviceType: string, sessionId: SessionId): Promise<Result<void, ToolError>> {
		const hadPendingRestart = this.cancelPendingRestart(serviceType)
		this.restartRetries.delete(serviceType)
		const entry = this.services.get(serviceType)
		if (!entry) {
			return Err({ message: `Service '${serviceType}' not found`, recoverable: false })
		}
		if (entry.status !== 'starting' && entry.status !== 'ready' && entry.status !== 'paused') {
			// A failed service with a revival queued is really "about to restart",
			// and calling that off is a legitimate stop rather than an error.
			if (hadPendingRestart) {
				try {
					await entry.forgetPid()
				} catch (error) {
					return Err({ message: this.errorWithContext(error, `Failed to forget PID for service '${serviceType}'`).message, recoverable: true })
				}
				entry.status = 'stopped'
				this.notifyStatusChanged(sessionId, serviceType, 'stopped')
				return Ok(undefined)
			}
			return Err({ message: `Service '${serviceType}' is ${entry.status}, cannot stop`, recoverable: false })
		}

		const previousStatus = entry.status
		entry.status = 'stopping'
		this.notifyStatusChanged(sessionId, serviceType, 'stopping')

		const gracefulStopMs = entry.config.gracefulStopMs ?? 5000

		const stopped = await this.terminateProcessGroup(entry.pid, gracefulStopMs)
		if (!stopped.ok) {
			if (entry.status === 'stopping') {
				entry.status = previousStatus
				this.notifyStatusChanged(sessionId, serviceType, previousStatus, {
					port: entry.port,
					cwd: entry.cwd,
					command: entry.command,
					error: stopped.error.message,
				})
			}
			return Err({ message: stopped.error.message, recoverable: true })
		}
		try {
			await entry.forgetPid()
		} catch (error) {
			return Err({ message: this.errorWithContext(error, `Failed to forget PID for service '${serviceType}'`).message, recoverable: true })
		}
		if (entry.status === 'stopping') {
			entry.status = 'stopped'
			this.notifyStatusChanged(sessionId, serviceType, 'stopped')
		}

		this.logger.info('Service stopped', { serviceType })
		return Ok(undefined)
	}

	/**
	 * Restart a service (stop + start).
	 */
	async restart(
		config: ServiceConfig,
		sessionId: SessionId,
		workspaceDir?: string,
		preferredPort?: number,
	): Promise<Result<void, ToolError>> {
		const entry = this.services.get(config.type)
		if (entry && (entry.status === 'starting' || entry.status === 'ready' || entry.status === 'paused')) {
			const stopResult = await this.stop(config.type, sessionId)
			if (!stopResult.ok) return stopResult
		}

		return this.start(config, sessionId, workspaceDir, preferredPort)
	}

	/**
	 * Pause a running service (SIGSTOP).
	 */
	async pause(serviceType: string, sessionId: SessionId): Promise<Result<void, ToolError>> {
		const entry = this.services.get(serviceType)
		if (!entry) {
			return Err({ message: `Service '${serviceType}' not found`, recoverable: false })
		}
		if (entry.status !== 'ready') {
			return Err({ message: `Service '${serviceType}' is ${entry.status}, cannot pause`, recoverable: false })
		}

		try {
			process.kill(entry.pid, 'SIGSTOP')
		} catch {
			return Err({ message: `Failed to pause service '${serviceType}'`, recoverable: false })
		}

		entry.status = 'paused'
		this.notifyStatusChanged(sessionId, serviceType, 'paused')

		this.logger.info('Service paused', { serviceType })
		return Ok(undefined)
	}

	/**
	 * Resume a paused service (SIGCONT).
	 */
	async resume(
		config: ServiceConfig,
		sessionId: SessionId,
		_workspaceDir?: string,
	): Promise<Result<void, ToolError>> {
		const entry = this.services.get(config.type)
		if (!entry) {
			return Err({ message: `Service '${config.type}' not found`, recoverable: false })
		}
		if (entry.status !== 'paused') {
			return Err({ message: `Service '${config.type}' is ${entry.status}, cannot resume`, recoverable: false })
		}

		try {
			process.kill(entry.pid, 'SIGCONT')
		} catch {
			return Err({ message: `Failed to resume service '${config.type}'`, recoverable: false })
		}

		entry.status = 'ready'
		this.notifyStatusChanged(sessionId, config.type, 'ready', {
			port: entry.port,
			cwd: entry.cwd,
			command: entry.command,
		})

		this.logger.info('Service resumed', { serviceType: config.type })
		return Ok(undefined)
	}

	/**
	 * Get recent log lines for a service.
	 */
	getLogs(serviceType: string, lines?: number): Result<string[], ToolError> {
		const entry = this.services.get(serviceType)
		if (!entry) {
			return Err({ message: `Service '${serviceType}' not found`, recoverable: false })
		}
		return Ok(lines ? entry.logs.last(lines) : entry.logs.toArray())
	}

	/**
	 * Get the current status of a service.
	 */
	getStatus(serviceType: string): ServiceStatus | null {
		return this.services.get(serviceType)?.status ?? null
	}

	/**
	 * Check if a service is running (starting or ready).
	 */
	isRunning(serviceType: string): boolean {
		const status = this.getStatus(serviceType)
		return status === 'starting' || status === 'ready' || status === 'paused'
	}

	/**
	 * Shutdown all services and release all ports back to pool.
	 * Called on session close.
	 */
	async shutdown(): Promise<void> {
		// Nothing queued may spawn after the executor is gone.
		for (const serviceType of [...this.restartTimers.keys()]) this.cancelPendingRestart(serviceType)
		this.restartRetries.clear()

		const promises: Promise<void>[] = []

		for (const [serviceType, entry] of this.services) {
			if (entry.status === 'starting' || entry.status === 'ready' || entry.status === 'paused' || entry.status === 'stopping') {
				const gracefulStopMs = entry.config.gracefulStopMs ?? 5000

				const killPromise = this.terminateProcessGroup(entry.pid, gracefulStopMs).then(async (stopped) => {
					if (!stopped.ok) throw stopped.error
					await entry.forgetPid()
				})

				promises.push(killPromise)
				entry.status = 'stopping'
				this.logger.info('Shutting down service', { serviceType })
			}
		}

		await Promise.all(promises)
		await Promise.all(this.pidForgets.values())
		this.services.clear()

		// Drain all waiters with error
		for (const [serviceType, pending] of this.waiters) {
			for (const waiter of pending) {
				clearTimeout(waiter.timer)
				waiter.resolve(Err({ message: `Service '${serviceType}' shut down`, recoverable: false }))
			}
		}
		this.waiters.clear()

		// Release all allocated ports back to pool
		for (const port of this.allocatedPorts.values()) {
			this.portPool.release(port)
		}
		this.allocatedPorts.clear()
	}
}
