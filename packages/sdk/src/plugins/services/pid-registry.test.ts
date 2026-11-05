import { describe, expect, it, spyOn } from 'bun:test'
import { spawn } from 'node:child_process'
import { readdir, readFile, mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { silentLogger } from '~/lib/logger/logger.js'
import { createNodePlatform } from '~/testing/node-platform.js'
import { ServicePidRegistry } from './pid-registry.js'
import { getProcessStartTime } from './service.js'

const fs = createNodePlatform().fs

async function withDataDir<T>(fn: (dataPath: string) => Promise<T>): Promise<T> {
	const dataPath = await mkdtemp(join(tmpdir(), 'pid-registry-'))
	try {
		return await fn(dataPath)
	} finally {
		await rm(dataPath, { recursive: true, force: true })
	}
}

/** A detached `sleep`, so `kill(-pid)` has a real process group to take down. */
function spawnVictim(): { pid: number; exited: Promise<void> } {
	const child = spawn('/bin/sh', ['-c', 'sleep 60'], { detached: true, stdio: 'ignore' })
	child.unref()
	if (!child.pid) throw new Error('failed to spawn victim')
	const exited = new Promise<void>(resolve => child.on('close', () => resolve()))
	return { pid: child.pid, exited }
}

/**
 * A detached group whose leader has exited while a member lives on: the pid reads as dead,
 * yet `kill(-pid)` would still reach somebody.
 */
async function spawnLeaderlessGroup(): Promise<number> {
	const leader = spawn('/bin/sh', ['-c', 'sleep 60 & exit 0'], { detached: true, stdio: 'ignore' })
	leader.unref()
	if (!leader.pid) throw new Error('failed to spawn group leader')
	await new Promise<void>(resolve => leader.on('close', () => resolve()))
	return leader.pid
}

function isGroupAlive(pgid: number): boolean {
	try {
		process.kill(-pgid, 0)
		return true
	} catch {
		return false
	}
}

/** Watch the signals sent to process groups; they still land. */
function watchGroupSignals() {
	const spy = spyOn(process, 'kill')
	return {
		sentTo: (pgid: number) => spy.mock.calls.filter(([target, signal]) => target === -pgid && signal !== 0).map(([, signal]) => signal),
		restore: () => spy.mockRestore(),
	}
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

/** A pid the kernel cannot have handed out, so it reads as a dead agent. */
async function unusablePid(): Promise<number> {
	const max = Number((await readFile('/proc/sys/kernel/pid_max', 'utf-8')).trim())
	return max + 1
}

async function writeRecord(dataPath: string, record: Record<string, unknown>): Promise<string> {
	const dir = join(dataPath, 'service-pids')
	await mkdir(dir, { recursive: true })
	const path = join(dir, `${record.sessionId}__${record.serviceType}.json`)
	await writeFile(path, JSON.stringify(record))
	return path
}

const makeRegistry = (dataPath: string) => new ServicePidRegistry(fs, silentLogger, dataPath)

describe('ServicePidRegistry', () => {
	it('kills a service left behind by an agent that is gone, and drops the record', async () => {
		await withDataDir(async dataPath => {
			const victim = spawnVictim()
			await writeRecord(dataPath, {
				sessionId: 'sess-1',
				serviceType: 'astro-dev',
				pid: victim.pid,
				pidStartTime: await getProcessStartTime(fs, victim.pid),
				command: 'sleep 60',
				agentPid: await unusablePid(),
				agentStartTime: 12345,
			})

			const signals = watchGroupSignals()
			try {
				await makeRegistry(dataPath).sweepOrphans()
				expect(signals.sentTo(victim.pid)).toEqual(['SIGKILL'])
			} finally {
				signals.restore()
			}

			await victim.exited
			expect(isAlive(victim.pid)).toBe(false)
			expect(await readdir(join(dataPath, 'service-pids'))).toEqual([])
		})
	})

	it('sends no signal to the group of a recorded pid that is no longer running, and drops the record', async () => {
		await withDataDir(async dataPath => {
			const pgid = await spawnLeaderlessGroup()
			const signals = watchGroupSignals()
			try {
				await writeRecord(dataPath, {
					sessionId: 'sess-1',
					serviceType: 'astro-dev',
					pid: pgid,
					pidStartTime: 12345,
					command: 'sleep 60',
					agentPid: await unusablePid(),
				})

				await makeRegistry(dataPath).sweepOrphans()

				expect(signals.sentTo(pgid)).toEqual([])
				expect(isGroupAlive(pgid)).toBe(true)
				expect(await readdir(join(dataPath, 'service-pids'))).toEqual([])
			} finally {
				signals.restore()
				process.kill(-pgid, 'SIGKILL')
			}
		})
	})

	it('sends no signal for a record that carries no start time, and drops the record', async () => {
		await withDataDir(async dataPath => {
			const victim = spawnVictim()
			const signals = watchGroupSignals()
			try {
				// Nothing tells the process the record meant from whoever holds that pid now.
				await writeRecord(dataPath, {
					sessionId: 'sess-1',
					serviceType: 'astro-dev',
					pid: victim.pid,
					command: 'sleep 60',
					agentPid: await unusablePid(),
				})

				await makeRegistry(dataPath).sweepOrphans()

				expect(signals.sentTo(victim.pid)).toEqual([])
				expect(isAlive(victim.pid)).toBe(true)
				expect(await readdir(join(dataPath, 'service-pids'))).toEqual([])
			} finally {
				signals.restore()
				process.kill(-victim.pid, 'SIGKILL')
			}
		})
	})

	it('leaves a service whose agent is still running', async () => {
		await withDataDir(async dataPath => {
			const victim = spawnVictim()
			try {
				// This test process stands in for a second, still-live agent.
				await writeRecord(dataPath, {
					sessionId: 'sess-1',
					serviceType: 'astro-dev',
					pid: victim.pid,
					pidStartTime: await getProcessStartTime(fs, victim.pid),
					command: 'sleep 60',
					agentPid: process.pid,
					agentStartTime: await getProcessStartTime(fs, process.pid),
				})

				await makeRegistry(dataPath).sweepOrphans()

				expect(isAlive(victim.pid)).toBe(true)
				expect(await readdir(join(dataPath, 'service-pids'))).toHaveLength(1)
			} finally {
				process.kill(-victim.pid, 'SIGKILL')
			}
		})
	})

	it('refuses to kill when the pid has been recycled', async () => {
		await withDataDir(async dataPath => {
			const victim = spawnVictim()
			try {
				const actual = await getProcessStartTime(fs, victim.pid)
				await writeRecord(dataPath, {
					sessionId: 'sess-1',
					serviceType: 'astro-dev',
					pid: victim.pid,
					// Deliberately not the process now holding this pid.
					pidStartTime: (actual ?? 0) + 999,
					command: 'sleep 60',
					agentPid: await unusablePid(),
				})

				const signals = watchGroupSignals()
				try {
					await makeRegistry(dataPath).sweepOrphans()
					expect(signals.sentTo(victim.pid)).toEqual([])
				} finally {
					signals.restore()
				}

				expect(isAlive(victim.pid)).toBe(true)
				// The record still goes — whatever holds that pid now, it is not ours to track.
				expect(await readdir(join(dataPath, 'service-pids'))).toEqual([])
			} finally {
				process.kill(-victim.pid, 'SIGKILL')
			}
		})
	})

	it('never sweeps what this very process started', async () => {
		await withDataDir(async dataPath => {
			const registry = makeRegistry(dataPath)
			const victim = spawnVictim()
			try {
				await registry.record({
					sessionId: 'sess-1',
					serviceType: 'astro-dev',
					pid: victim.pid,
					pidStartTime: await getProcessStartTime(fs, victim.pid),
					command: 'sleep 60',
				})

				await registry.sweepOrphans()

				expect(isAlive(victim.pid)).toBe(true)
			} finally {
				process.kill(-victim.pid, 'SIGKILL')
			}
		})
	})

	it('drops an unreadable record instead of throwing', async () => {
		await withDataDir(async dataPath => {
			const dir = join(dataPath, 'service-pids')
			await mkdir(dir, { recursive: true })
			await writeFile(join(dir, 'sess-1__astro-dev.json'), 'not json')

			await makeRegistry(dataPath).sweepOrphans()

			expect(await readdir(dir)).toEqual([])
		})
	})

	it('does nothing when no service has ever been recorded', async () => {
		await withDataDir(async dataPath => {
			await makeRegistry(dataPath).sweepOrphans()
		})
	})

	it('forget removes the record for a service that has exited', async () => {
		await withDataDir(async dataPath => {
			const registry = makeRegistry(dataPath)
			await registry.record({ sessionId: 'sess-1', serviceType: 'astro-dev', pid: 1, pidStartTime: 1, command: 'x' })
			expect(await readdir(join(dataPath, 'service-pids'))).toHaveLength(1)

			await registry.forget('sess-1', 'astro-dev')

			expect(await readdir(join(dataPath, 'service-pids'))).toEqual([])
		})
	})
})
