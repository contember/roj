/**
 * ServicePidRegistry — on-disk record of the service processes this host has spawned,
 * so a later agent can find and kill the ones nobody owns any more.
 *
 * The session projection cannot do this job. It remembers one pid per service type, so
 * every start overwrites the previous generation, and its reconcile runs from
 * `onSessionReady` — which fires lazily, when a session is loaded. A session nobody
 * reopens after a restart therefore never reconciles at all, and its dev server keeps
 * running until the box runs out of memory. That is not theoretical: a production
 * sandbox on 2026-08-05 held four dev servers at ~500 MB each across three sessions on
 * 4 GB with no swap, and the kernel OOM-killer fired repeatedly.
 *
 * A file per (session, service type) survives both an agent restart and a VM
 * pause/resume, and is enumerable without knowing which sessions exist — which is what
 * makes a host-wide sweep at boot possible.
 */

import { join } from 'node:path'
import type { FileSystem } from '~/platform/fs.js'
import type { Logger } from '../../lib/logger/logger.js'
import { getProcessStartTime } from './service.js'

/**
 * What we need in order to decide, later and from another process, whether a recorded
 * pid may be killed.
 *
 * `pidStartTime` is /proc's start time in clock ticks: paired with the pid it identifies
 * one process, so a mismatch means the kernel recycled the pid and killing would hit an
 * unrelated process. `agentPid`/`agentStartTime` identify the agent that spawned it — a
 * booting agent must not kill the services of another agent that is still running.
 */
export interface ServicePidRecord {
	sessionId: string
	serviceType: string
	pid: number
	pidStartTime?: number
	command: string
	agentPid: number
	agentStartTime?: number
}

const REGISTRY_DIR = 'service-pids'

/**
 * Collapse anything that could steer a path into a single safe token. Session ids arrive as
 * caller-supplied text (`sessions.create` takes an unconstrained string), so `..` or a slash
 * would let `join` walk out of the registry directory and unlink or overwrite something else.
 */
const safeSegment = (value: string): string => value.replace(/[^A-Za-z0-9._-]/g, '_')

export class ServicePidRegistry {
	constructor(
		private readonly fs: FileSystem,
		private readonly logger: Logger,
		/** Agent data directory. Never the session workspace — that is a git worktree. */
		private readonly dataPath: string,
	) {}

	private get root(): string {
		return join(this.dataPath, REGISTRY_DIR)
	}

	/**
	 * One file per spawned PROCESS, not per (session, service type).
	 *
	 * Keying by the pair would reproduce the very limitation this registry exists to fix: the
	 * session projection keeps one pid per service type, so each start loses the previous
	 * generation. The incident that motivated all of this was two generations of one pair —
	 * two dev servers for a single session — and a pair-keyed file would have recorded only
	 * the newer one and left the older running for good.
	 *
	 * The name is sanitised because a session id reaches us as caller-supplied text: `join`
	 * would happily walk `..` out of the registry directory and unlink something else. Field
	 * values are read from the file body, so collapsing characters here is harmless.
	 */
	private recordPath(sessionId: string, serviceType: string, pid: number): string {
		return join(this.root, `${safeSegment(sessionId)}__${safeSegment(serviceType)}__${pid}.json`)
	}

	/**
	 * Record a freshly spawned service process. Best-effort: failing to record costs us a
	 * later sweep, so it must never take down the start that just succeeded.
	 */
	async record(record: Omit<ServicePidRecord, 'agentPid' | 'agentStartTime'>): Promise<void> {
		try {
			await this.fs.mkdir(this.root, { recursive: true })
			const full: ServicePidRecord = {
				...record,
				agentPid: process.pid,
				agentStartTime: await getProcessStartTime(this.fs, process.pid),
			}
			await this.fs.writeFile(this.recordPath(record.sessionId, record.serviceType, record.pid), JSON.stringify(full))
		} catch (error) {
			this.logger.debug('Could not record service pid', { sessionId: record.sessionId, serviceType: record.serviceType, error })
		}
	}

	/**
	 * Drop the record for a service process that has exited.
	 *
	 * The pid is what makes this safe. A stale generation's `close` can arrive long after its
	 * replacement has started — a grandchild that ignored SIGTERM keeps the inherited pipes
	 * open until it dies — and without the pid it would delete the live process's record and
	 * silently reintroduce the leak.
	 */
	async forget(sessionId: string, serviceType: string, pid: number): Promise<void> {
		try {
			await this.fs.unlink(this.recordPath(sessionId, serviceType, pid))
		} catch {
			// Already gone, or never recorded.
		}
	}

	/**
	 * Kill every recorded service process that no live agent owns, and clear its record.
	 *
	 * Meant to run once at agent boot, before any session loads: at that moment this agent
	 * tracks nothing, so every survivor of a previous incarnation is by definition an
	 * orphan. Records left by an agent that is still running are skipped — during an
	 * overlapping restart the outgoing agent's services are still its own.
	 */
	async sweepOrphans(): Promise<void> {
		let files: string[]
		try {
			files = await this.fs.readdir(this.root)
		} catch {
			return // No registry yet — nothing has ever been spawned here.
		}

		for (const file of files) {
			if (!file.endsWith('.json')) continue
			const path = join(this.root, file)
			const record = await this.readRecord(path)
			if (!record) {
				await this.fs.unlink(path).catch(() => {})
				continue
			}

			if (await this.isAgentAlive(record)) {
				this.logger.debug('Leaving service to its still-running agent', {
					sessionId: record.sessionId,
					serviceType: record.serviceType,
					agentPid: record.agentPid,
				})
				continue
			}

			await this.killIfStillOurs(record)
			await this.fs.unlink(path).catch(() => {})
		}
	}

	private async readRecord(path: string): Promise<ServicePidRecord | null> {
		try {
			const parsed: unknown = JSON.parse(await this.fs.readFile(path, 'utf-8'))
			if (typeof parsed !== 'object' || parsed === null) return null
			const record = parsed as Partial<ServicePidRecord>
			if (typeof record.pid !== 'number' || typeof record.sessionId !== 'string' || typeof record.serviceType !== 'string') {
				return null
			}
			return {
				sessionId: record.sessionId,
				serviceType: record.serviceType,
				pid: record.pid,
				pidStartTime: record.pidStartTime,
				command: typeof record.command === 'string' ? record.command : '',
				agentPid: typeof record.agentPid === 'number' ? record.agentPid : 0,
				agentStartTime: record.agentStartTime,
			}
		} catch {
			return null
		}
	}

	/**
	 * Whether a live agent still owns this record — including ourselves, which is what lets the
	 * sweep run at any time rather than only before the first service start.
	 *
	 * Ownership needs the start time to agree, not just the pid. After a genuine reboot the pid
	 * space restarts, so a dead agent's record can name the pid we now hold; trusting the pid
	 * alone would mark its orphans "ours" and skip them forever.
	 */
	private async isAgentAlive(record: ServicePidRecord): Promise<boolean> {
		if (record.agentPid === 0) return false
		// Our own pid is only proof of ownership if the start times agree too. After a real
		// reboot the pid space restarts, so a dead agent's record can carry the pid we now hold;
		// skipping those as "ours" would disable the sweep for exactly the records it exists for.
		const currentStartTime = await getProcessStartTime(this.fs, record.agentPid)
		if (currentStartTime === undefined) return false
		if (record.agentStartTime === undefined) return record.agentPid === process.pid
		return currentStartTime === record.agentStartTime
	}

	private async killIfStillOurs(record: ServicePidRecord): Promise<void> {
		// Fail closed on anything that would widen the blast radius. `kill(-1)` signals every
		// process we may signal — the whole VM, as root in a sandbox — and killing our own group
		// would take the agent down at boot, forever.
		if (record.pid <= 1 || record.pid === process.pid) {
			this.logger.warn('Refusing to sweep an unusable service pid', {
				sessionId: record.sessionId,
				serviceType: record.serviceType,
				pid: record.pid,
			})
			return
		}
		const currentStartTime = await getProcessStartTime(this.fs, record.pid)
		if (currentStartTime === undefined) return // Process is gone.
		// No recorded start time means we cannot prove this pid is still the process we spawned.
		// A wrong SIGKILL is far worse than a leaked process, so decline.
		if (record.pidStartTime === undefined || currentStartTime !== record.pidStartTime) {
			this.logger.warn('Cannot prove this pid is still our service — refusing to kill', {
				sessionId: record.sessionId,
				serviceType: record.serviceType,
				pid: record.pid,
				storedStartTime: record.pidStartTime,
				currentStartTime,
			})
			return
		}

		try {
			// Negative pid: services are spawned detached, so this takes the whole group —
			// the `/bin/sh -c` wrapper and the runtime it exec'd underneath it.
			process.kill(-record.pid, 'SIGKILL')
			this.logger.info('Killed orphaned service process group', {
				sessionId: record.sessionId,
				serviceType: record.serviceType,
				pid: record.pid,
				command: record.command,
			})
		} catch (error) {
			this.logger.debug('Orphaned service process already gone', { pid: record.pid, error })
		}
	}
}
