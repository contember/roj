import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { appendFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateTestAgentId } from '~/core/agents/schema.js'
import { agentEvents } from '~/core/agents/state.js'
import { generateSessionId, type SessionId, sessionMetadataSchema } from '~/core/sessions/schema.js'
import { sessionEvents } from '~/core/sessions/state.js'
import type { FileSystem } from '~/platform/fs.js'
import { createNodeFileSystem } from '~/testing/node-platform.js'
import { EventAppendError, EventAppendOutcomeUnknownError, EventLogCorruptionError, FileEventStoreCapabilityError } from './event-store.js'
import { FileEventStore } from './file.js'
import { withSessionId } from './test-helpers.js'
import type { DomainEvent } from './types.js'

interface Hooks {
	appendFile?(path: string, data: string | Uint8Array, append: () => Promise<void>): Promise<void>
	beforeWrite?(path: string): Promise<void>
	beforeRename?(source: string, dest: string): Promise<void>
	beforeRead?(path: string): Promise<void>
}

function instrument(inner: FileSystem, hooks: Hooks): FileSystem {
	function readFile(path: string): Promise<Buffer>
	function readFile(path: string, encoding: 'utf-8' | 'utf8'): Promise<string>
	async function readFile(path: string, encoding?: 'utf-8' | 'utf8'): Promise<Buffer | string> {
		await hooks.beforeRead?.(path)
		return encoding === undefined ? inner.readFile(path) : inner.readFile(path, encoding)
	}
	const move = inner.rename?.bind(inner)
	if (!move) throw new Error('Test adapter requires rename')
	return {
		...inner,
		readFile,
		async appendFile(path, data) {
			const append = () => inner.appendFile(path, data)
			await (hooks.appendFile ? hooks.appendFile(path, data, append) : append())
		},
		async writeFile(path, data) {
			await hooks.beforeWrite?.(path)
			await inner.writeFile(path, data)
		},
		async rename(source, dest) {
			await hooks.beforeRename?.(source, dest)
			await move(source, dest)
		},
	}
}

describe('FileEventStore recovery', () => {
	let root: string
	let id: SessionId
	let directory: string
	let log: string
	let events: DomainEvent[]
	const native = createNodeFileSystem()
	const failure = new Error('injected failure')
	const fresh = (fs = native) => new FileEventStore(root, fs)
	const spawned = () => withSessionId(id, agentEvents.create('agent_spawned', { agentId: generateTestAgentId(), definitionName: 'test', parentId: null }))

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'roj-jsonl-'))
		id = generateSessionId()
		directory = join(root, 'sessions', id, '.events')
		log = join(directory, 'events.jsonl')
		events = [
			withSessionId(id, sessionEvents.create('session_created', { presetId: 'žluťoučký 🌍' })),
			withSessionId(id, sessionEvents.create('session_closed', {})),
		]
	})

	afterEach(async () => {
		await rm(root, { recursive: true, force: true })
	})

	test('requires rename before any write', () => {
		expect(() => fresh({ ...native, rename: undefined })).toThrow(FileEventStoreCapabilityError)
	})

	test('a torn last line is not an event, and the next append drops it', async () => {
		await fresh().append(id, events[0])
		await appendFile(log, '{"type":"session_clo')
		expect(await fresh().load(id)).toEqual([events[0]])
		expect(await fresh().loadRange(id, { since: -1, limit: 1 })).toEqual({ events: [events[0]], fromIndex: 0, toIndex: 0 })

		await fresh().append(id, events[1])
		expect(await fresh().load(id)).toEqual(events)
		expect(await readFile(log, 'utf8')).toBe(events.map((event) => `${JSON.stringify(event)}\n`).join(''))
		expect((await readdir(directory)).filter((name) => name.startsWith('.pending-'))).toEqual([])
	})

	test('an append that wrote nothing is a definite noncommit, and a retry commits once', async () => {
		let fail = true
		const store = fresh(instrument(native, {
			async appendFile(_path, _data, append) {
				if (fail) throw failure
				await append()
			},
		}))
		await expect(store.appendBatch(id, events)).rejects.toBeInstanceOf(EventAppendError)
		fail = false
		await store.appendBatch(id, events)
		expect(await fresh().load(id)).toEqual(events)
	})

	test('a partly written batch is rolled back, so none of it is visible', async () => {
		await fresh().append(id, events[0])
		const batch = [spawned(), spawned(), events[1]]
		const store = fresh(instrument(native, {
			async appendFile(path, data) {
				// Two complete lines and part of the third: without the rollback the prefix would replay.
				const lines = String(data).split('\n')
				await native.appendFile(path, `${lines[0]}\n${lines[1]}\n${lines[2].slice(0, 5)}`)
				throw failure
			},
		}))
		await expect(store.appendBatch(id, batch)).rejects.toBeInstanceOf(EventAppendError)
		expect(await fresh().load(id)).toEqual([events[0]])

		await fresh().appendBatch(id, batch)
		expect(await fresh().load(id)).toEqual([events[0], ...batch])
	})

	test('an append that cannot be rolled back has an unknown outcome, and the log decides it', async () => {
		await fresh().append(id, events[0])
		const store = fresh(instrument(native, {
			async appendFile(_path, _data, append) {
				await append()
				throw failure
			},
			async beforeRename() {
				throw failure
			},
		}))
		await expect(store.append(id, events[1])).rejects.toBeInstanceOf(EventAppendOutcomeUnknownError)
		expect(await fresh().load(id)).toEqual(events)
	})

	describe('after the session moves to another host and back', () => {
		const tornByOtherHost = async () => {
			const other = fresh()
			await other.load(id)
			await other.appendBatch(id, [spawned(), spawned()])
			await appendFile(log, '{"type":"agent_spa')
		}

		test('the next append drops the torn tail the other host left', async () => {
			const store = fresh()
			await store.append(id, events[0])
			await tornByOtherHost()

			const history = await store.load(id)
			expect(history).toHaveLength(3)
			const next = spawned()
			await store.append(id, next)
			expect(await fresh().load(id)).toEqual([...history, next])
		})

		test('a failed append does not roll back over what the other host committed', async () => {
			let fail = false
			const store = fresh(instrument(native, {
				async appendFile(_path, _data, append) {
					if (fail) throw failure
					await append()
				},
			}))
			await store.append(id, events[0])
			await tornByOtherHost()

			expect(await store.load(id)).toHaveLength(3)
			fail = true
			await expect(store.append(id, spawned())).rejects.toBeInstanceOf(EventAppendError)
			expect(await fresh().load(id)).toHaveLength(3)
		})

		test('a failed append that finds bytes it did not write has an unknown outcome and keeps them', async () => {
			let fail = false
			const store = fresh(instrument(native, {
				async appendFile(_path, _data, append) {
					if (fail) throw failure
					await append()
				},
			}))
			await store.append(id, events[0])
			await fresh().appendBatch(id, [spawned(), spawned()])

			fail = true
			await expect(store.append(id, spawned())).rejects.toBeInstanceOf(EventAppendOutcomeUnknownError)
			expect(await fresh().load(id)).toHaveLength(3)
		})
	})

	test('an append whose rollback failed leaves the counters to be rebuilt from the log', async () => {
		await fresh().append(id, events[0])
		let fail = true
		const store = fresh(instrument(native, {
			async appendFile(_path, _data, append) {
				await append()
				if (fail) throw failure
			},
			async beforeRename() {
				if (fail) throw failure
			},
		}))
		const unknown = spawned()
		await expect(store.append(id, unknown)).rejects.toBeInstanceOf(EventAppendOutcomeUnknownError)

		fail = false
		const next = spawned()
		await store.append(id, next)
		expect(await fresh().getMetadata(id)).toMatchObject({ metrics: { totalEvents: 3, totalAgents: 2 } })
		expect(await store.loadRange(id, { since: 0 })).toEqual({ events: [unknown, next], fromIndex: 1, toIndex: 2 })
	})

	test('a complete line that does not parse is corruption, not a torn tail', async () => {
		await fresh().append(id, events[0])
		await appendFile(log, 'not json\n')
		await expect(fresh().load(id)).rejects.toBeInstanceOf(EventLogCorruptionError)
	})

	test('a committed append survives a metadata failure, and the next append repairs the counters', async () => {
		await fresh().append(id, events[0])
		let fail = true
		const store = fresh(instrument(native, {
			async beforeWrite(path) {
				if (fail && path.endsWith('meta.json')) throw failure
			},
		}))
		await store.append(id, spawned())
		expect(await fresh().load(id)).toHaveLength(2)

		fail = false
		await store.append(id, events[1])
		const metadata = sessionMetadataSchema.parse(JSON.parse(await readFile(join(directory, 'meta.json'), 'utf8')))
		expect(metadata).toMatchObject({ status: 'closed', metrics: { totalEvents: 3, totalAgents: 1 } })
		expect(await store.loadRange(id, { since: 1 })).toEqual({ events: [events[1]], fromIndex: 2, toIndex: 2 })
	})

	test('listing sessions reads metadata only, never an event log', async () => {
		await fresh().appendBatch(id, events)
		const other = generateSessionId()
		await fresh().append(other, withSessionId(other, sessionEvents.create('session_created', { presetId: 'test' })))
		const reads: string[] = []
		const store = fresh(instrument(native, {
			async beforeRead(path) {
				reads.push(path)
			},
		}))
		expect((await store.listSessionsWithMetadata()).total).toBe(2)
		expect(reads.filter((path) => path.endsWith('events.jsonl'))).toEqual([])
	})

	test('a since below -1 reads from the start instead of slicing from the end', async () => {
		const store = fresh()
		await store.appendBatch(id, events)
		expect(await store.loadRange(id, { since: -5 })).toEqual({ events, fromIndex: 0, toIndex: 1 })
		expect(await store.loadRange(id, { since: -5, limit: 1 })).toEqual({ events: [events[0]], fromIndex: 0, toIndex: 0 })
	})

	test('concurrent appends and metadata updates preserve all counters and custom fields', async () => {
		const store = fresh()
		await store.append(id, events[0])
		await Promise.all([
			...Array.from({ length: 20 }, () => store.append(id, spawned())),
			store.updateMetadata(id, { name: 'concurrent', tags: ['kept'] }),
		])
		expect(await store.load(id)).toHaveLength(21)
		expect(await fresh().getMetadata(id)).toMatchObject({ metrics: { totalEvents: 21 }, name: 'concurrent', tags: ['kept'] })
	})

})
