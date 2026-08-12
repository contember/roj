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
import { getProcessStartTime, reapServiceProcessGroup } from './service.js'

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

	private recordPath(sessionId: string, serviceType: string): string {
		// Service types are plugin-configured identifiers (`astro-dev`, `cms-sidecar`) and
		// session ids are uuids, so neither needs escaping to be a safe file name.
		return join(this.root, `${sessionId}__${serviceType}.json`)
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
			await this.fs.writeFile(this.recordPath(record.sessionId, record.serviceType), JSON.stringify(full))
		} catch (error) {
			this.logger.debug('Could not record service pid', { sessionId: record.sessionId, serviceType: record.serviceType, error })
		}
	}

	/** Drop the record for a service whose process is gone. */
	async forget(sessionId: string, serviceType: string): Promise<void> {
		try {
			await this.fs.unlink(this.recordPath(sessionId, serviceType))
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
	 * Whether a live agent still owns this record. Ourselves counts: a record carrying our own
	 * pid describes a service this very process started, which the sweep must never touch —
	 * that is what makes the sweep safe to run at any time, not only before the first start.
	 */
	private async isAgentAlive(record: ServicePidRecord): Promise<boolean> {
		if (record.agentPid === process.pid) return true
		if (record.agentPid === 0) return false
		const currentStartTime = await getProcessStartTime(this.fs, record.agentPid)
		if (currentStartTime === undefined) return false
		return record.agentStartTime === undefined || currentStartTime === record.agentStartTime
	}

	private async killIfStillOurs(record: ServicePidRecord): Promise<void> {
		await reapServiceProcessGroup(
			this.fs,
			this.logger,
			{ pid: record.pid, pidStartTime: record.pidStartTime },
			{ sessionId: record.sessionId, serviceType: record.serviceType, command: record.command, reason: 'orphan sweep' },
		)
	}
}
