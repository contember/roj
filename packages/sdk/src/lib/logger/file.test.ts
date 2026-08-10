import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import type { FileSystem } from '~/platform/fs.js'
import { createNodeFileSystem } from '~/testing/node-platform.js'
import { FileLogger } from './file.js'

const dirs: string[] = []

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'roj-file-logger-'))
	dirs.push(dir)
	return dir
}

/** Messages in the order the file holds them. */
async function messages(path: string): Promise<string[]> {
	const content = await readFile(path, 'utf-8')
	return content
		.split('\n')
		.filter((line) => line.length > 0)
		.map((line) => {
			const parsed: unknown = JSON.parse(line)
			if (typeof parsed !== 'object' || parsed === null || !('message' in parsed)) throw new Error(`not an entry: ${line}`)
			return String(parsed.message)
		})
}

afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('FileLogger', () => {
	test('keeps lines in the order they were logged, whatever order the appends finish in', async () => {
		const inner = createNodeFileSystem()
		// Each append is held longer than the one after it, so unserialized writes land reversed.
		const delays = [30, 20, 10]
		let call = 0
		const fs: FileSystem = {
			...inner,
			appendFile: async (path, data) => {
				await Bun.sleep(delays[call++] ?? 0)
				await inner.appendFile(path, data)
			},
		}

		const logPath = join(await tempDir(), 'session.log')
		const logger = new FileLogger(logPath, fs)
		logger.info('first')
		logger.child({ agentId: 'a1' }).info('second')
		logger.info('third')
		await Bun.sleep(120)

		expect(await messages(logPath)).toEqual(['first', 'second', 'third'])
	})

	test('orders lines across separate loggers over the same file', async () => {
		const inner = createNodeFileSystem()
		let call = 0
		const fs: FileSystem = {
			...inner,
			appendFile: async (path, data) => {
				await Bun.sleep(call++ === 0 ? 30 : 0)
				await inner.appendFile(path, data)
			},
		}

		const logPath = join(await tempDir(), 'session.log')
		new FileLogger(logPath, fs).info('first')
		new FileLogger(logPath, fs).info('second')
		await Bun.sleep(120)

		expect(await messages(logPath)).toEqual(['first', 'second'])
	})

	test('drops the line a failed append lost and keeps writing the rest', async () => {
		const inner = createNodeFileSystem()
		let call = 0
		const fs: FileSystem = {
			...inner,
			appendFile: async (path, data) => {
				if (call++ === 0) throw new Error('ENOSPC')
				await inner.appendFile(path, data)
			},
		}

		const logPath = join(await tempDir(), 'session.log')
		const logger = new FileLogger(logPath, fs)
		expect(() => logger.info('lost')).not.toThrow()
		await Bun.sleep(20)
		logger.info('kept')
		await Bun.sleep(20)

		expect(await messages(logPath)).toEqual(['kept'])
	})

	test('does not queue one file behind another', async () => {
		const dir = await tempDir()
		const heldPath = join(dir, 'held.log')
		const freePath = join(dir, 'free.log')

		let release = (): void => {}
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		const inner = createNodeFileSystem()
		const fs: FileSystem = {
			...inner,
			appendFile: async (path, data) => {
				if (path === heldPath) await gate
				await inner.appendFile(path, data)
			},
		}

		new FileLogger(heldPath, fs).info('held')
		new FileLogger(freePath, fs).info('free')
		await Bun.sleep(20)

		expect(await messages(freePath)).toEqual(['free'])
		expect(await inner.exists(heldPath)).toBe(false)

		release()
		await Bun.sleep(20)
		expect(await messages(heldPath)).toEqual(['held'])
	})
})
