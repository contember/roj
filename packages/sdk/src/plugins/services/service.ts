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
	pidRegistry?: ServicePidRegistry
}

export class ServiceExecutor {
	private readonly services = new Map<string, RunningService>()
	private readonly allocatedPorts = new Map<string, number>()
	private readonly waiters = new Map<string, Array<{ resolve: (result: Result<void, ToolError>) => void; timer: ReturnType<typeof setTimeout> }>>()
	/** Per-type lock collapsing concurrent start() calls onto a single in-flight start. */
	private readonly startInFlight = new Map<string, Promise<Result<void, ToolError>>>()
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
	private readonly pidRegistry?: ServicePidRegistry

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
		if (existing && (existing.status === 'starting' || existing.status === 'ready')) {
			return Ok(undefined)
		}

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
		const logBufferSize = config.logBufferSize ?? 200
		const startupTimeoutMs = config.startupTimeoutMs ?? 30_000

		const readyRegex = config.readyPattern ? new RegExp(config.readyPattern) : undefined

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

		// Listen before the first await. Neither Node nor Bun replays buffered stdio
		// or a 'close' to a listener attached after the child exited, and the two
		// awaits below — the /proc start-time read and the pid-registry write — are
		// long enough for a fast crash (bad command, missing binary, occupied port)
		// to slip through the gap. These collectors hold both until the real
		// handlers exist further down, which then take over and replay them.
		const bufferedStdout: Buffer[] = []
		const bufferedStderr: Buffer[] = []
		let exitDuringSetup: { code: number | null } | undefined
		const bufferStdout = (data: Buffer) => void bufferedStdout.push(data)
		const bufferStderr = (data: Buffer) => void bufferedStderr.push(data)
		const bufferClose = (code: number | null) => {
			exitDuringSetup = { code }
		}
		child.stdout?.on('data', bufferStdout)
		child.stderr?.on('data', bufferStderr)
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

		const logs = new RingBuffer(logBufferSize)
		const startTime = Date.now()
		// Set when the child reports a port bind-conflict; read by the close handler
		// to decide between a fresh-port retry and a terminal failure.
		let portConflictDetected = false

		const entry: RunningService = {
			config,
			process: child,
			pid: child.pid,
			status: 'starting',
			port,
			cwd,
			command,
			logs,
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

		const processLine = (line: string) => {
			logs.push(line)
			if (PORT_CONFLICT_PATTERN.test(line)) {
				portConflictDetected = true
			}
			const current = this.services.get(config.type)
			if (!current || current.process !== child) return

			if (current.status === 'starting') {
				this.logger.debug('Service output', { serviceType: config.type, line })
			}

			if (readyRegex && current.status === 'starting') {
				if (readyRegex.test(line)) {
					markReady(line)
				}
			}

			void checkReadyWhen()
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
			void checkReadyWhen()
		}

		// Pipe stdout/stderr line by line
		let stdoutPartial = ''
		const onStdout = (data: Buffer) => {
			stdoutPartial += data.toString()
			const lines = stdoutPartial.split('\n')
			stdoutPartial = lines.pop()!
			for (const line of lines) {
				processLine(line)
			}
		}

		let stderrPartial = ''
		const onStderr = (data: Buffer) => {
			stderrPartial += data.toString()
			const lines = stderrPartial.split('\n')
			stderrPartial = lines.pop()!
			for (const line of lines) {
				processLine(`[stderr] ${line}`)
			}
		}

		// Take over from the setup collectors and replay what they caught, so a
		// service that already spoke (or already died) is judged on its real output:
		// the ready pattern, the port-conflict pattern and the failure log all read
		// from it. Swap and replay synchronously — no 'data' can land in between.
		child.stdout?.off('data', bufferStdout)
		child.stderr?.off('data', bufferStderr)
		child.stdout?.on('data', onStdout)
		child.stderr?.on('data', onStderr)
		for (const chunk of bufferedStdout) onStdout(chunk)
		for (const chunk of bufferedStderr) onStderr(chunk)

		// Handle unexpected exit. Named and guarded because it also has to be
		// replayable — see the exit-during-setup check after markReady() below.
		let closeHandled = false
		const handleClose = (code: number | null) => {
			if (closeHandled) return
			closeHandled = true
			clearReadinessTimers()
			// The process is gone, so its durable record has nothing left to reap.
			void this.pidRegistry?.forget(String(sessionId), config.type)
			// Flush remaining partial lines
			if (stdoutPartial) {
				processLine(stdoutPartial)
				stdoutPartial = ''
			}
			if (stderrPartial) {
				processLine(`[stderr] ${stderrPartial}`)
				stderrPartial = ''
			}

			const current = this.services.get(config.type)
			if (!current || current.process !== child) return

			if (current.status === 'stopping') {
				// Expected stop
				current.status = 'stopped'
				this.notifyStatusChanged(sessionId, config.type, 'stopped')
			} else if (current.status === 'starting' || current.status === 'ready') {
				const retries = this.portConflictRetries.get(config.type) ?? 0
				if (portConflictDetected && retries < MAX_PORT_CONFLICT_RETRIES) {
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
					void this.start(config, sessionId, workspaceDir)
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
		// setup collector was listening, so replay that close now — its output has
		// just been replayed, so the handler sees the same log a live exit would.
		// `alreadyReaped` covers the in-between state: the exit is recorded but
		// 'close' has not fired yet because it waits for the stdio EOF. The listener
		// above is guaranteed to receive it, so calling handleClose here would only
		// drop the tail of the log the failure has to explain — while marking such a
		// child ready would be a lie.
		const alreadyReaped = child.exitCode != null || child.signalCode != null
		if (exitDuringSetup) {
			handleClose(exitDuringSetup.code)
		} else if (!alreadyReaped && !readyRegex && !config.readyWhen) {
			// If no ready condition is configured, a live child is ready immediately.
			markReady()
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
				entry.status = 'stopped'
				this.notifyStatusChanged(sessionId, serviceType, 'stopped')
				return Ok(undefined)
			}
			return Err({ message: `Service '${serviceType}' is ${entry.status}, cannot stop`, recoverable: false })
		}

		entry.status = 'stopping'
		this.notifyStatusChanged(sessionId, serviceType, 'stopping')

		const gracefulStopMs = entry.config.gracefulStopMs ?? 5000

		// Send SIGTERM
		try {
			process.kill(-entry.pid, 'SIGTERM')
		} catch {
			// Process already gone
			entry.status = 'stopped'
			this.notifyStatusChanged(sessionId, serviceType, 'stopped')
			return Ok(undefined)
		}

		// Wait for graceful shutdown, then SIGKILL
		await new Promise<void>((resolve) => {
			const checkInterval = setInterval(() => {
				try {
					// Check if process is still alive (signal 0 doesn't kill, just checks)
					process.kill(entry.pid, 0)
				} catch {
					// Process gone
					clearInterval(checkInterval)
					clearTimeout(killTimeout)
					resolve()
				}
			}, 200)

			const killTimeout = setTimeout(() => {
				clearInterval(checkInterval)
				try {
					process.kill(-entry.pid, 'SIGKILL')
				} catch {
					// Already gone
				}
				resolve()
			}, gracefulStopMs)
		})

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
		return status === 'starting' || status === 'ready'
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
			if (entry.status === 'starting' || entry.status === 'ready' || entry.status === 'paused') {
				const gracefulStopMs = entry.config.gracefulStopMs ?? 5000

				const killPromise = new Promise<void>((resolve) => {
					try {
						process.kill(-entry.pid, 'SIGTERM')
					} catch {
						resolve()
						return
					}

					const killTimeout = setTimeout(() => {
						try {
							process.kill(-entry.pid, 'SIGKILL')
						} catch {
							// Already gone
						}
						resolve()
					}, gracefulStopMs)

					const checkInterval = setInterval(() => {
						try {
							process.kill(entry.pid, 0)
						} catch {
							clearInterval(checkInterval)
							clearTimeout(killTimeout)
							resolve()
						}
					}, 200)
				})

				promises.push(killPromise)
				entry.status = 'stopping'
				this.logger.info('Shutting down service', { serviceType })
			}
		}

		await Promise.all(promises)
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
