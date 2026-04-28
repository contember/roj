/**
 * ServiceExecutor - Manages child processes for session services.
 *
 * Each service type has at most one running instance per session.
 * Services are long-running background processes (e.g., dev servers).
 * Ports are allocated from a global PortPool and injected via PORT env var.
 */

import type { SessionId } from '~/core/sessions/schema.js'
import type { Result } from '~/lib/utils/result.js'
import { Err, Ok } from '~/lib/utils/result.js'
import type { FileSystem } from '~/platform/fs.js'
import type { ChildProcess, ProcessRunner } from '~/platform/process.js'
import type { PortPool } from '~/plugins/services/port-pool.js'
import type { ServiceConfig, ServiceStatus } from '~/plugins/services/schema.js'
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
	logs: RingBuffer
}

// ============================================================================
// ServiceExecutor
// ============================================================================

export interface ServiceExecutorDeps {
	fs: FileSystem
	process: ProcessRunner
}

export class ServiceExecutor {
	private readonly services = new Map<string, RunningService>()
	private readonly allocatedPorts = new Map<string, number>()
	private readonly waiters = new Map<string, Array<{ resolve: (result: Result<void, ToolError>) => void; timer: ReturnType<typeof setTimeout> }>>()
	private readonly logger: Logger
	private readonly portPool: PortPool
	private readonly fs: FileSystem
	private readonly processRunner: ProcessRunner

	/** Optional callback invoked on every service status change */
	onStatusChanged?: (
		sessionId: string,
		serviceType: string,
		status: ServiceStatus,
		port?: number,
		error?: string,
		pid?: number,
		pidStartTime?: number,
	) => void

	constructor(logger: Logger, portPool: PortPool, deps: ServiceExecutorDeps) {
		this.logger = logger
		this.portPool = portPool
		this.fs = deps.fs
		this.processRunner = deps.process
	}

	private notifyStatusChanged(
		sessionId: string,
		serviceType: string,
		status: ServiceStatus,
		port?: number,
		error?: string,
		pid?: number,
		pidStartTime?: number,
	): void {
		this.onStatusChanged?.(sessionId, serviceType, status, port, error, pid, pidStartTime)
		if (status === 'ready' || status === 'failed' || status === 'stopped') {
			this.resolveWaiters(serviceType, status, error)
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
	 */
	async start(
		config: ServiceConfig,
		sessionId: SessionId,
		workspaceDir?: string,
		preferredPort?: number,
	): Promise<Result<void, ToolError>> {
		const existing = this.services.get(config.type)
		if (existing && (existing.status === 'starting' || existing.status === 'ready')) {
			return Ok(undefined)
		}

		// Allocate port: reuse session-level allocation, then try preferred, then random
		let port = this.allocatedPorts.get(config.type)
		if (port === undefined) {
			port = this.portPool.allocatePreferred(preferredPort) ?? undefined
			if (port === undefined) {
				this.notifyStatusChanged(sessionId, config.type, 'failed', undefined, 'No ports available in pool')
				return Err({ message: 'No ports available in pool', recoverable: true })
			}
			this.allocatedPorts.set(config.type, port)
		}

		const cwd = config.cwd ?? workspaceDir
		const logBufferSize = config.logBufferSize ?? 200
		const startupTimeoutMs = config.startupTimeoutMs ?? 30_000

		const readyRegex = config.readyPattern ? new RegExp(config.readyPattern) : undefined

		// Resolve command: callback gets port, string used as-is
		const command = typeof config.command === 'function'
			? config.command({ port })
			: config.command

		const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
		const shellFlag = process.platform === 'win32' ? '/c' : '-c'

		const child = this.processRunner.spawn(shell, [shellFlag, command], {
			cwd,
			env: { ...process.env, ...config.env, PORT: String(port) },
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
				this.notifyStatusChanged(sessionId, config.type, 'failed', undefined, error.message)
			}
		})

		if (!child.pid) {
			this.notifyStatusChanged(sessionId, config.type, 'failed', undefined, 'Failed to spawn process')
			return Err({ message: 'Failed to spawn service process', recoverable: true })
		}

		// Capture start time immediately so a later PID-reuse check can distinguish
		// "our process" from "an unrelated process that grabbed this PID after ours died"
		const pidStartTime = await getProcessStartTime(this.fs, child.pid)

		// Emit starting event with PID, port (port is known at allocation time), and start time
		this.notifyStatusChanged(sessionId, config.type, 'starting', port, undefined, child.pid, pidStartTime)

		const logs = new RingBuffer(logBufferSize)
		const startTime = Date.now()

		const entry: RunningService = {
			config,
			process: child,
			pid: child.pid,
			status: 'starting',
			port,
			logs,
		}
		this.services.set(config.type, entry)

		const processLine = (line: string) => {
			logs.push(line)
			const current = this.services.get(config.type)
			if (!current || current.process !== child) return

			if (current.status === 'starting') {
				this.logger.debug('Service output', { serviceType: config.type, line })
			}

			// Check for ready pattern
			if (readyRegex && current.status === 'starting') {
				if (readyRegex.test(line)) {
					current.status = 'ready'
					if (startupTimer) clearTimeout(startupTimer)
					const startupDurationMs = Date.now() - startTime
					this.notifyStatusChanged(sessionId, config.type, 'ready', current.port)
					this.logger.info('Service ready', {
						serviceType: config.type,
						port: current.port,
						startupDurationMs,
						matchedLine: line,
					})
				}
			}
		}

		// Startup timeout — mark as failed if not ready in time
		let startupTimer: ReturnType<typeof setTimeout> | undefined
		if (readyRegex) {
			startupTimer = setTimeout(() => {
				const current = this.services.get(config.type)
				if (!current || current.process !== child || current.status !== 'starting') return

				current.status = 'failed'
				const errorMsg = `Service startup timed out after ${startupTimeoutMs}ms`
				this.logger.error(errorMsg, undefined, { serviceType: config.type })
				this.notifyStatusChanged(sessionId, config.type, 'failed', undefined, errorMsg)

				// Kill the timed-out process
				try {
					process.kill(-current.pid, 'SIGKILL')
				} catch {
					// Already gone
				}
			}, startupTimeoutMs)
		}

		// Pipe stdout/stderr line by line
		let stdoutPartial = ''
		child.stdout?.on('data', (data: Buffer) => {
			stdoutPartial += data.toString()
			const lines = stdoutPartial.split('\n')
			stdoutPartial = lines.pop()!
			for (const line of lines) {
				processLine(line)
			}
		})

		let stderrPartial = ''
		child.stderr?.on('data', (data: Buffer) => {
			stderrPartial += data.toString()
			const lines = stderrPartial.split('\n')
			stderrPartial = lines.pop()!
			for (const line of lines) {
				processLine(`[stderr] ${line}`)
			}
		})

		// Handle unexpected exit
		child.on('close', (code) => {
			if (startupTimer) clearTimeout(startupTimer)
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
				// Unexpected exit
				current.status = 'failed'
				const errorMsg = `Process exited unexpectedly with code ${code}`
				this.notifyStatusChanged(sessionId, config.type, 'failed', undefined, errorMsg)
				this.logger.warn('Service process exited unexpectedly', {
					serviceType: config.type,
					code,
				})
			}
		})

		this.logger.info('Service starting', {
			serviceType: config.type,
			pid: child.pid,
			port,
			command,
			cwd,
			readyPattern: config.readyPattern,
			startupTimeoutMs,
		})

		// If no ready pattern, immediately mark as ready
		if (!readyRegex) {
			entry.status = 'ready'
			this.notifyStatusChanged(sessionId, config.type, 'ready', port)
		}

		return Ok(undefined)
	}

	/**
	 * Stop a running service gracefully.
	 * Port is NOT released — kept for session-level stability across restarts.
	 */
	async stop(serviceType: string, sessionId: SessionId): Promise<Result<void, ToolError>> {
		const entry = this.services.get(serviceType)
		if (!entry) {
			return Err({ message: `Service '${serviceType}' not found`, recoverable: false })
		}
		if (entry.status !== 'starting' && entry.status !== 'ready' && entry.status !== 'paused') {
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
		this.notifyStatusChanged(sessionId, config.type, 'ready', entry.port)

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
