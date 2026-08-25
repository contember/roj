/**
 * ServiceExecutor - Manages child processes for session services.
 *
 * Each service type has at most one running instance per session.
 * Services are long-running background processes (e.g., dev servers).
 * Ports are allocated from a global PortPool and injected via PORT env var.
 */

import { resolve } from 'node:path'
import type { SessionCloseReason } from '~/core/plugins/plugin-builder.js'
import type { SessionId } from '~/core/sessions/schema.js'
import type { Result } from '~/lib/utils/result.js'
import { Err, Ok } from '~/lib/utils/result.js'
import type { FileSystem } from '~/platform/fs.js'
import type { ChildProcess, ProcessRunner } from '~/platform/process.js'
import type { PortPool } from '~/plugins/services/port-pool.js'
import type { ServicePidRegistry } from '~/plugins/services/pid-registry.js'
import type { ServiceConfig, ServiceStartArgs, ServiceStatus, ServiceStopSource } from '~/plugins/services/schema.js'
import type { ToolError } from '../../core/tools/executor.js'
import type { LogContext, Logger } from '../../lib/logger/logger.js'
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
	/** Captured at spawn so a later reap can tell our process from a recycled pid. */
	pidStartTime?: number
	status: ServiceStatus
	port: number
	cwd?: string
	command: string
	logs: RingBuffer
	forgetPid: () => Promise<void>
	/** Set once the child's `close` fired, or once we gave up our claim on the group. */
	exited: boolean
	/** Who asked for the stop in progress — read back when the child's exit lands. */
	stopSource?: ServiceStopSource
}

/** A process we spawned and may still have to reclaim. */
export interface ReapTarget {
	pid: number
	/** Start time captured at spawn; undefined on non-Linux, or when /proc was unreadable. */
	pidStartTime?: number
}

/**
 * What a guarded reap did. `killed` covers a group that was already gone — the signal
 * had nothing left to reach. `pid-reused` means the kernel handed the pid on and the
 * process under it is somebody else's.
 */
export type ReapOutcome = 'killed' | 'pid-reused'

export interface ServiceStatusChangeDetails {
	port?: number
	error?: string
	pid?: number
	pidStartTime?: number
	cwd?: string
	command?: string
	/** Set on a `stopped` change: who asked for it. See ServiceEntry.stoppedBy. */
	stoppedBy?: ServiceStopSource
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

/**
 * Deadline for embedder callbacks and PID-registry writes inside a transition.
 *
 * A transition holds the runtime lease that idle eviction waits on, so a resolver
 * or a registry write that never settles pins the session resident forever and
 * defeats the bound the lease exists to enforce. None of them is meant to take
 * 30 s — the deadline only turns "wedged" into "failed".
 */
const DEFAULT_SERVICE_HOOK_TIMEOUT_MS = 30_000

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
	/** Deadline for embedder callbacks and PID-registry writes; test seam, defaults to 30 s. */
	hookTimeoutMs?: number
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
	/** Per-type stop operation awaited by runtime disposal. */
	private readonly stopInFlight = new Map<string, Promise<Result<void, ToolError>>>()
	/** Registry deletions that must settle before a replacement can record its PID. */
	private readonly pidForgets = new Map<string, Promise<void>>()
	/** Per-type counter bounding automatic EADDRINUSE port re-allocation retries. */
	private readonly portConflictRetries = new Map<string, number>()
	private readonly portConflictTimers = new Map<string, ReturnType<typeof setTimeout>>()
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
	private readonly hookTimeoutMs: number
	private closing = false
	private closePromise?: Promise<void>

	/** Optional callback invoked on every service status change */
	onStatusChanged?: (
		sessionId: string,
		serviceType: string,
		status: ServiceStatus,
		details: ServiceStatusChangeDetails,
	) => void
	/** Invoked after every owned start attempt, including deferred retries. */
	onStartSettled?: (serviceType: string) => void

	constructor(logger: Logger, portPool: PortPool, deps: ServiceExecutorDeps) {
		this.logger = logger
		this.portPool = portPool
		this.fs = deps.fs
		this.processRunner = deps.process
		this.pidRegistry = deps.pidRegistry
		this.killProcess = deps.kill ?? process.kill
		this.hookTimeoutMs = deps.hookTimeoutMs ?? DEFAULT_SERVICE_HOOK_TIMEOUT_MS
		serviceExecutorObserverForTesting?.(this)
	}

	/**
	 * Reject when `operation` outlives {@link DEFAULT_SERVICE_HOOK_TIMEOUT_MS}.
	 *
	 * The operation itself cannot be cancelled — an embedder callback keeps running —
	 * but the transition stops waiting on it, which is what releases the lease.
	 */
	private async withDeadline<T>(label: string, operation: () => Promise<T> | T): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined
		try {
			return await Promise.race([
				(async () => await operation())(),
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error(`${label} did not settle within ${this.hookTimeoutMs}ms`)),
						this.hookTimeoutMs,
					)
				}),
			])
		} finally {
			if (timer) clearTimeout(timer)
		}
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
			return Ok(await this.withDeadline(
				`Service '${config.type}' availability check`,
				() => config.availableWhen?.({ sessionId: String(sessionId), workspaceDir }) ?? true,
			))
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
				const cwdResolver = config.cwd
				const raw = await this.withDeadline(
					`Service '${config.type}' cwd resolver`,
					() => cwdResolver({ sessionId: String(sessionId), workspaceDir }),
				)
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
		if (this.closing) return Err({ message: 'Service executor is closing', recoverable: false })
		const inFlight = this.startInFlight.get(config.type)
		if (inFlight) return inFlight

		const promise = this.startInternal(config, sessionId, workspaceDir, preferredPort)
		this.startInFlight.set(config.type, promise)
		try {
			return await promise
		} finally {
			this.startInFlight.delete(config.type)
			this.onStartSettled?.(config.type)
		}
	}

	private async startInternal(
		config: ServiceConfig,
		sessionId: SessionId,
		workspaceDir?: string,
		preferredPort?: number,
	): Promise<Result<void, ToolError>> {
		if (this.closing) return Err({ message: 'Service executor is closing', recoverable: false })
		// This start supersedes any revival the policy had queued.
		this.cancelPendingRestart(config.type)

		const existing = this.services.get(config.type)
		if (existing && (existing.status === 'starting' || existing.status === 'ready')) {
			return Ok(undefined)
		}
		if (existing?.status === 'stopping') {
			return Err({ message: `Service '${config.type}' is stopping, cannot start`, recoverable: true })
		}
		if (existing) {
			// Whatever sits under this type is about to be overwritten — in this map and in
			// the pid registry, both keyed by (session, type) — and to lose its port to the
			// process spawned below, since a restart deliberately reuses it. A `failed`
			// entry can still own a live process group, so reclaim it before its handle is
			// dropped or nothing will ever be able to find it again.
			const reaped = await this.reapEntry(existing, 'superseded by a new start')
			if (!reaped.ok) {
				this.logger.warn('Could not reclaim the superseded service process group', {
					serviceType: config.type,
					pid: existing.pid,
					error: reaped.error.message,
				})
			}
			await existing.forgetPid()
		}
		await this.pidForgets.get(config.type)
		if (this.closing) return Err({ message: 'Service executor is closing', recoverable: false })

		const availability = await this.isAvailable(config, sessionId, workspaceDir)
		if (this.closing) return Err({ message: 'Service executor is closing', recoverable: false })
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
		if (this.closing) {
			if (allocatedNow) {
				this.allocatedPorts.delete(config.type)
				this.portPool.release(port)
			}
			return Err({ message: 'Service executor is closing', recoverable: false })
		}
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
			const commandResolver = config.command
			command = typeof commandResolver === 'function'
				? await this.withDeadline(`Service '${config.type}' command resolver`, () => commandResolver(startArgs))
				: commandResolver
			const envResolver = config.env
			serviceEnv = typeof envResolver === 'function'
				? await this.withDeadline(`Service '${config.type}' env resolver`, () => envResolver(startArgs))
				: envResolver
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
		if (this.closing) {
			if (allocatedNow) {
				this.allocatedPorts.delete(config.type)
				this.portPool.release(port)
			}
			return Err({ message: 'Service executor is closing', recoverable: false })
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
				// The pid rides along on purpose — see the startup timeout below.
				this.notifyStatusChanged(sessionId, config.type, 'failed', {
					error: error.message,
					cwd,
					command,
					pid: current.pid,
					pidStartTime: current.pidStartTime,
				})
				void this.reapEntry(current, 'process error').then((reaped) => {
					if (!reaped.ok) {
						this.logger.error('Could not kill errored service process group', reaped.error, { serviceType: config.type, pid: current.pid })
					}
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
		// Bind the narrowed pid: the deferred registry call below cannot carry the
		// narrowing across the closure boundary.
		const pid = child.pid

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
			const runForget = () => this.withDeadline(
				`Service '${config.type}' PID forget`,
				() => this.pidRegistry?.forget(String(sessionId), config.type) ?? Promise.resolve(),
			)
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
		try {
			await this.withDeadline(
				`Service '${config.type}' PID record`,
				() => this.pidRegistry?.record({ sessionId: String(sessionId), serviceType: config.type, pid, pidStartTime, command })
					?? Promise.resolve(),
			)
		} catch (error) {
			// The child is already running but unrecorded, so nothing could reap it
			// after a crash — tear it down here rather than leak it.
			const message = error instanceof Error ? error.message : String(error)
			const errorMessage = `Service '${config.type}' could not record its PID: ${message}`
			try {
				this.killProcess(-child.pid, 'SIGKILL')
			} catch {
				// The process may already be gone.
			}
			if (allocatedNow) {
				this.allocatedPorts.delete(config.type)
				this.portPool.release(port)
			}
			this.notifyStatusChanged(sessionId, config.type, 'failed', { port, cwd, command, error: errorMessage })
			return Err({ message: errorMessage, recoverable: true })
		}
		if (this.closing) {
			try {
				this.killProcess(-child.pid, 'SIGKILL')
			} catch {
				// The process may already be gone.
			}
			await forgetPid()
			if (allocatedNow) {
				this.allocatedPorts.delete(config.type)
				this.portPool.release(port)
			}
			return Err({ message: 'Service executor is closing', recoverable: false })
		}

		// Emit starting event with PID, port, resolved cwd/command, and start time.
		this.notifyStatusChanged(sessionId, config.type, 'starting', { port, pid: child.pid, pidStartTime, cwd, command })

		const entry: RunningService = {
			config,
			process: child,
			pid: child.pid,
			pidStartTime,
			status: 'starting',
			port,
			cwd,
			command,
			logs,
			forgetPid,
			exited: false,
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
				// The pid rides along on purpose: should this agent die before the reap
				// below completes, the recorded pid is all a later boot has to find the
				// survivor. The child's exit takes the claim away again.
				this.notifyStatusChanged(sessionId, config.type, 'failed', {
					port: current.port,
					cwd: current.cwd,
					command: current.command,
					error: errorMsg,
					pid: current.pid,
					pidStartTime: current.pidStartTime,
				})

				void this.reapEntry(current, 'startup timeout').then((reaped) => {
					if (!reaped.ok) {
						this.logger.error('Could not kill timed-out service process group', reaped.error, { serviceType: config.type, pid: current.pid })
					}
				})
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
			entry.exited = true
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
				// Expected stop — the child's exit, not stopInternal, is what publishes it.
				current.status = 'stopped'
				this.notifyStatusChanged(sessionId, config.type, 'stopped', { stoppedBy: current.stopSource ?? 'agent' })
			} else if (current.status === 'starting' || current.status === 'ready') {
				const retries = this.portConflictRetries.get(config.type) ?? 0
				if (!this.closing && current.status === 'starting' && portConflictDetected && retries < MAX_PORT_CONFLICT_RETRIES) {
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
						const retryTimer = setTimeout(() => {
							this.portConflictTimers.delete(config.type)
							if (!this.closing) void this.start(config, sessionId, workspaceDir)
						}, 0)
						retryTimer.unref?.()
						this.portConflictTimers.set(config.type, retryTimer)
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
			} else if (current.status === 'failed') {
				// The process this entry still claimed is now confirmed gone — a startup
				// timeout or a process error published the pid without being able to
				// confirm the kill. Take the claim away so no later boot goes looking for
				// it; the status and the error that explain the failure stay as they are.
				this.notifyStatusChanged(sessionId, config.type, 'failed')
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
			if (this.closing) return Err({ message: 'Service executor is closing', recoverable: false })
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
		if (this.closing) return undefined
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
			if (!this.closing) void this.start(config, sessionId, workspaceDir)
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

	/**
	 * Whether the service is down but coming back on its own — a `restartPolicy`
	 * revival or a queued port-conflict retry. Both are timers this executor
	 * owns, so both need the runtime to outlive the call that armed them.
	 */
	hasScheduledRestart(serviceType: string): boolean {
		return this.restartTimers.has(serviceType) || this.portConflictTimers.has(serviceType)
	}

	/**
	 * Stop accepting work and drain all runtime-owned processes and timers.
	 *
	 * `reason: 'evicted'` only parks the session: every service keeps its full
	 * graceful window and is recorded as stopped by the runtime, which is what
	 * lets autoStart bring it back once the runtime is rebuilt. The other
	 * reasons end the session, so a process group that ignores SIGTERM is taken
	 * down without waiting.
	 */
	close(sessionId: SessionId, reason: SessionCloseReason = 'closed'): Promise<void> {
		this.closing = true
		this.closePromise ??= this.performClose(sessionId, reason).finally(() => {
			this.onStatusChanged = undefined
			this.onStartSettled = undefined
		})
		return this.closePromise
	}

	private async performClose(sessionId: SessionId, reason: SessionCloseReason): Promise<void> {
		this.cancelPortConflictTimers()
		await Promise.allSettled([...this.startInFlight.values()])
		this.cancelPortConflictTimers()
		const concurrentStopTypes = new Set(this.stopInFlight.keys())
		await Promise.allSettled([...this.stopInFlight.values()])

		// One service that cannot be signalled must not strand the others, and must not
		// skip the tail — portPool is process-global, so a skipped release loses those
		// ports for the life of the server.
		const failures: unknown[] = []
		const parking = reason === 'evicted'
		try {
			for (const [serviceType, entry] of [...this.services]) {
				if (entry.status === 'stopped') continue
				if (entry.status === 'starting' || entry.status === 'ready' || entry.status === 'stopping' || this.restartTimers.has(serviceType)) {
					const forcedGraceMs = parking ? entry.config.gracefulStopMs ?? 5000 : 0
					try {
						if (concurrentStopTypes.has(serviceType)) {
							await this.forceStopForClose(serviceType, entry, sessionId, forcedGraceMs)
							continue
						}
						const stopped = await this.stop(serviceType, sessionId, 'eviction')
						if (!stopped.ok) await this.forceStopForClose(serviceType, entry, sessionId, forcedGraceMs)
					} catch (error) {
						failures.push(error)
					}
				}
			}
		} finally {
			this.cancelAllDeferredStarts()
			await Promise.allSettled([...this.pidForgets.values()])
			for (const port of this.allocatedPorts.values()) this.portPool.release(port)
			this.allocatedPorts.clear()
			this.services.clear()
			for (const serviceType of this.waiters.keys()) this.resolveWaiters(serviceType, 'stopped')
		}

		// Still reject — a close that could not terminate a process is not a clean close.
		if (failures.length === 1) throw failures[0]
		if (failures.length > 1) {
			throw new AggregateError(failures, `Failed to stop ${failures.length} services during close`)
		}
	}

	private async forceStopForClose(serviceType: string, entry: RunningService, sessionId: SessionId, gracefulStopMs: number): Promise<void> {
		const previousStatus = entry.status
		this.recordStopSource(entry, 'eviction')
		if (entry.status !== 'stopping') {
			entry.status = 'stopping'
			this.notifyStatusChanged(sessionId, serviceType, 'stopping')
		}
		const stopped = await this.terminateProcessGroup(entry.pid, gracefulStopMs)
		if (!stopped.ok) {
			// Mirror stopInternal: no recovery path matches a stranded `stopping`, so a
			// force-stop that failed has to leave a status the next runtime can reap.
			if (entry.status === 'stopping' && previousStatus !== 'stopping') {
				entry.status = previousStatus
				this.notifyStatusChanged(sessionId, serviceType, previousStatus, {
					port: entry.port,
					cwd: entry.cwd,
					command: entry.command,
					error: stopped.error.message,
				})
			}
			throw stopped.error
		}
		// The group is confirmed gone, so nothing may offer this pid up for a reap again.
		entry.exited = true
		await entry.forgetPid()
		if (this.services.get(serviceType) === entry) {
			entry.status = 'stopped'
			this.notifyStatusChanged(sessionId, serviceType, 'stopped', { stoppedBy: entry.stopSource ?? 'eviction' })
		}
	}

	/** An agent stop stays the agent's decision even when a lifecycle stop is what finishes it. */
	private recordStopSource(entry: RunningService, stoppedBy: ServiceStopSource): void {
		if (stoppedBy === 'agent' || entry.stopSource === undefined) entry.stopSource = stoppedBy
	}

	private cancelAllDeferredStarts(): void {
		for (const timer of this.restartTimers.values()) clearTimeout(timer)
		this.restartTimers.clear()
		this.cancelPortConflictTimers()
	}

	private cancelPortConflictTimers(): void {
		for (const timer of this.portConflictTimers.values()) clearTimeout(timer)
		this.portConflictTimers.clear()
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

	/**
	 * Reclaim a service process group we spawned, unless the kernel recycled its pid.
	 *
	 * Every path that gives up on a service comes through here, because ending the
	 * *wait* is not ending the *process*: a dev server that missed its readiness
	 * window keeps its several hundred MB of RSS until somebody kills it, which on a
	 * memory-starved box is what makes the next startup miss its window too.
	 *
	 * `pidStartTime` was captured at spawn, so a different current start time means
	 * the pid now belongs to an unrelated process and killing it would be disastrous.
	 * An unknown start time (non-Linux, no /proc) leaves only the kill-and-hope path.
	 */
	async reapProcessGroup(target: ReapTarget, context: LogContext = {}): Promise<Result<ReapOutcome, Error>> {
		const currentStartTime = await getProcessStartTime(this.fs, target.pid)
		if (target.pidStartTime !== undefined && currentStartTime !== undefined && currentStartTime !== target.pidStartTime) {
			this.logger.warn('PID reuse detected — refusing to kill service process group', {
				...context,
				pid: target.pid,
				storedStartTime: target.pidStartTime,
				currentStartTime,
			})
			return Ok('pid-reused')
		}

		const killed = this.killProcessGroup(target.pid)
		if (!killed.ok) return killed
		return Ok('killed')
	}

	/**
	 * Reclaim the process group of an entry we are giving up on or replacing.
	 *
	 * A no-op once the child's `close` has fired: there is nothing left to reclaim,
	 * and skipping it also keeps the non-Linux kill-and-hope path away from a pid the
	 * kernel may since have handed to somebody else. A settled reap ends our claim,
	 * so the entry is never offered up twice.
	 */
	private async reapEntry(entry: RunningService, reason: string): Promise<Result<void, Error>> {
		if (entry.exited) return Ok(undefined)
		const reaped = await this.reapProcessGroup(
			{ pid: entry.pid, pidStartTime: entry.pidStartTime },
			{ serviceType: entry.config.type, reason },
		)
		if (!reaped.ok) return reaped
		entry.exited = true
		return Ok(undefined)
	}

	/**
	 * SIGKILL a process group through the injectable kill seam, without waiting
	 * for it to go. Reached through {@link reapProcessGroup} wherever a recorded
	 * pid could have been recycled.
	 */
	killProcessGroup(pid: number): Result<void, Error> {
		try {
			this.killProcess(-pid, 'SIGKILL')
			return Ok(undefined)
		} catch (error) {
			if (this.hasErrorCode(error, 'ESRCH')) return Ok(undefined) // Already gone.
			return Err(this.errorWithContext(error, `Failed to SIGKILL process group ${pid}`))
		}
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
	async stop(serviceType: string, sessionId: SessionId, stoppedBy: ServiceStopSource = 'agent'): Promise<Result<void, ToolError>> {
		const inFlight = this.stopInFlight.get(serviceType)
		if (inFlight) return inFlight

		let operation: Promise<Result<void, ToolError>>
		operation = this.stopInternal(serviceType, sessionId, stoppedBy).finally(() => {
			if (this.stopInFlight.get(serviceType) === operation) this.stopInFlight.delete(serviceType)
		})
		this.stopInFlight.set(serviceType, operation)
		return operation
	}

	private async stopInternal(serviceType: string, sessionId: SessionId, stoppedBy: ServiceStopSource): Promise<Result<void, ToolError>> {
		const hadPendingRestart = this.cancelPendingRestart(serviceType)
		this.restartRetries.delete(serviceType)
		const entry = this.services.get(serviceType)
		if (!entry) {
			return Err({ message: `Service '${serviceType}' not found`, recoverable: false })
		}
		if (entry.status !== 'starting' && entry.status !== 'ready') {
			// `failed` says the start gave up, not that the process did — and refusing to
			// stop it left the platform-side reaper, the one caller that can free a leaked
			// dev server's memory, with no way to do so. A failed service with a revival
			// queued is on top of that really "about to restart", and calling that off is a
			// legitimate stop rather than an error.
			if (entry.status === 'failed' || hadPendingRestart) {
				const reaped = await this.reapEntry(entry, 'stopped while failed')
				if (!reaped.ok) return Err({ message: reaped.error.message, recoverable: true })
				try {
					await entry.forgetPid()
				} catch (error) {
					return Err({ message: this.errorWithContext(error, `Failed to forget PID for service '${serviceType}'`).message, recoverable: true })
				}
				entry.status = 'stopped'
				this.notifyStatusChanged(sessionId, serviceType, 'stopped', { stoppedBy })
				return Ok(undefined)
			}
			return Err({ message: `Service '${serviceType}' is ${entry.status}, cannot stop`, recoverable: false })
		}

		const previousStatus = entry.status
		this.recordStopSource(entry, stoppedBy)
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
		// The group is confirmed gone, so nothing may offer this pid up for a reap again.
		entry.exited = true
		try {
			await entry.forgetPid()
		} catch (error) {
			return Err({ message: this.errorWithContext(error, `Failed to forget PID for service '${serviceType}'`).message, recoverable: true })
		}
		if (entry.status === 'stopping') {
			entry.status = 'stopped'
			this.notifyStatusChanged(sessionId, serviceType, 'stopped', { stoppedBy: entry.stopSource ?? stoppedBy })
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
		if (entry && (entry.status === 'starting' || entry.status === 'ready')) {
			const stopResult = await this.stop(config.type, sessionId)
			if (!stopResult.ok) return stopResult
		}

		return this.start(config, sessionId, workspaceDir, preferredPort)
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
}
