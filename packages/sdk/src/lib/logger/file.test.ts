import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNodeFileSystem } from '~/testing/node-platform.js'
import { FileLogger, flushFileLogs } from './file.js'

const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function logPath(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'roj-file-logger-'))
	roots.push(root)
	return join(root, 'session.log')
}

async function messages(path: string): Promise<string[]> {
	const text = await readFile(path, 'utf-8')
	return text.split('\n').filter(line => line !== '').map(line => JSON.parse(line).message)
}

describe('FileLogger', () => {
	test('writes a burst of lines in the order they were logged', async () => {
		const path = await logPath()
		const logger = new FileLogger(path, createNodeFileSystem())

		const expected = Array.from({ length: 200 }, (_, index) => `line-${index}`)
		for (const message of expected) logger.info(message)
		await flushFileLogs(path)

		expect(await messages(path)).toEqual(expected)
	})

	test('keeps that order across child loggers, which share the file', async () => {
		const path = await logPath()
		const logger = new FileLogger(path, createNodeFileSystem())

		const expected: string[] = []
		for (let index = 0; index < 100; index++) {
			const message = `line-${index}`
			expected.push(message)
			// A child is a separate instance over the same path — the chain is keyed by path.
			logger.child({ agentId: `a${index}` }).info(message)
		}
		await flushFileLogs(path)

		expect(await messages(path)).toEqual(expected)
	})

	test('a failed append does not stop the lines after it', async () => {
		const path = await logPath()
		const fs = createNodeFileSystem()
		let failNext = true
		const logger = new FileLogger(path, {
			...fs,
			appendFile: async (target, data) => {
				if (failNext) {
					failNext = false
					throw new Error('EIO')
				}
				await fs.appendFile(target, data)
			},
		})

		logger.info('dropped')
		logger.info('kept')
		await flushFileLogs(path)

		expect(await messages(path)).toEqual(['kept'])
	})
})
