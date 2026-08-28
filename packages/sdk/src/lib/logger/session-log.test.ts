import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Platform, SessionLogPage, SessionLogStore } from '~/platform/index.js'
import { createNodePlatform } from '~/testing/node-platform.js'
import type { Logger } from './logger.js'
import { createSessionLogger } from './session-log.js'

const SESSION_ID = '01900000-0000-7000-8000-000000000001'

/** What a host with a table for the log does, without the SQL. */
class MemorySessionLog implements SessionLogStore {
	readonly bySession = new Map<string, string[]>()

	append(sessionId: string, line: string): void {
		const lines = this.bySession.get(sessionId) ?? []
		lines.push(line)
		this.bySession.set(sessionId, lines)
	}

	async read(sessionId: string, since: number): Promise<SessionLogPage> {
		const all = this.bySession.get(sessionId) ?? []
		const lines = all.slice(since)
		return { lines, offset: Math.min(since, all.length) + lines.length }
	}

	async delete(sessionId: string): Promise<number> {
		const count = this.bySession.get(sessionId)?.length ?? 0
		this.bySession.delete(sessionId)
		return count
	}
}

const dirs: string[] = []

async function fileHost(): Promise<{ platform: Platform; logPath: string }> {
	const dir = await mkdtemp(join(tmpdir(), 'roj-session-log-'))
	dirs.push(dir)
	return { platform: createNodePlatform(), logPath: join(dir, 'session.log') }
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Entries as written, with the wall clock dropped — the one field two runs cannot share. */
function entries(lines: string[]): Record<string, unknown>[] {
	return lines.map((line) => {
		const parsed: unknown = JSON.parse(line)
		if (!isRecord(parsed)) throw new Error(`not a JSON object: ${line}`)
		const record: Record<string, unknown> = { ...parsed }
		delete record.timestamp
		return record
	})
}

async function fileEntries(logPath: string): Promise<Record<string, unknown>[]> {
	return entries((await readFile(logPath, 'utf-8')).split('\n').filter((line) => line.length > 0))
}

afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('createSessionLogger', () => {
	test('writes the session.log file when the host has no store', async () => {
		const { platform, logPath } = await fileHost()

		const logger = createSessionLogger(platform, SESSION_ID, logPath)
		logger.info('hello', { agentId: 'a1' })
		// The append is fire-and-forget, so the assertion has to outlive the microtask.
		await Bun.sleep(20)

		expect(await fileEntries(logPath)).toEqual([
			{ level: 'info', message: 'hello', sessionId: SESSION_ID, agentId: 'a1' },
		])
	})

	test('writes rows and leaves the filesystem alone when the host has a store', async () => {
		const { platform, logPath } = await fileHost()
		const store = new MemorySessionLog()

		const logger = createSessionLogger({ ...platform, sessionLog: store }, SESSION_ID, logPath)
		logger.info('hello', { agentId: 'a1' })
		await Bun.sleep(20)

		expect(store.bySession.get(SESSION_ID)).toHaveLength(1)
		expect(await platform.fs.exists(logPath)).toBe(false)
	})

	test('produces the same entries either way', async () => {
		const { platform, logPath } = await fileHost()
		const store = new MemorySessionLog()
		const boom = new Error('boom')

		const write = (logger: Logger) => {
			logger.debug('starting', { turn: 1 })
			logger.child({ agentId: 'a1' }).warn('slow', { ms: 12 })
			logger.error('failed', boom)
		}
		write(createSessionLogger(platform, SESSION_ID, logPath))
		write(createSessionLogger({ ...platform, sessionLog: store }, SESSION_ID, logPath))
		await Bun.sleep(20)

		const fromFile = await fileEntries(logPath)
		expect(entries(store.bySession.get(SESSION_ID) ?? [])).toEqual(fromFile)
		expect(fromFile).toMatchObject([
			{ level: 'debug', message: 'starting', sessionId: SESSION_ID, turn: 1 },
			{ level: 'warn', message: 'slow', sessionId: SESSION_ID, agentId: 'a1', ms: 12 },
			{ level: 'error', message: 'failed', sessionId: SESSION_ID, error: { message: 'boom' } },
		])
	})

	test('logs at debug whatever the host is, because the session log is the detailed record', async () => {
		const { platform, logPath } = await fileHost()

		expect(createSessionLogger(platform, SESSION_ID, logPath).level).toBe('debug')
		expect(createSessionLogger({ ...platform, sessionLog: new MemorySessionLog() }, SESSION_ID, logPath).level).toBe('debug')
	})

	test('keeps the sink across child loggers', async () => {
		const { platform, logPath } = await fileHost()
		const store = new MemorySessionLog()

		const logger = createSessionLogger({ ...platform, sessionLog: store }, SESSION_ID, logPath)
		logger.child({ agentId: 'a1' }).child({ toolName: 't' }).info('nested')
		await Bun.sleep(20)

		expect(entries(store.bySession.get(SESSION_ID) ?? [])).toEqual([
			{ level: 'info', message: 'nested', sessionId: SESSION_ID, agentId: 'a1', toolName: 't' },
		])
		expect(await platform.fs.exists(logPath)).toBe(false)
	})

	test('drops the line when the store cannot write, exactly as a failed append is swallowed', async () => {
		const { platform, logPath } = await fileHost()
		const throwing: SessionLogStore = {
			append: () => {
				throw new Error('SQLITE_FULL')
			},
			read: async () => ({ lines: [], offset: 0 }),
			delete: async () => 0,
		}

		const logger = createSessionLogger({ ...platform, sessionLog: throwing }, SESSION_ID, logPath)

		expect(() => logger.info('hello')).not.toThrow()
	})

	test('swallows a failed file append too', async () => {
		const { platform } = await fileHost()

		const logger = createSessionLogger(platform, SESSION_ID, join(tmpdir(), 'roj-session-log-missing', 'session.log'))

		expect(() => logger.info('hello')).not.toThrow()
		await Bun.sleep(20)
	})
})
