import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { generateSessionId, type SessionId, sessionMetadataSchema } from '~/core/sessions/schema.js'
import { sessionEvents } from '~/core/sessions/state.js'
import { withSessionId } from './test-helpers.js'
import type { DomainEvent } from './types.js'
import type { FileSystem } from '~/platform/fs.js'
import { createNodeFileSystem } from '~/testing/node-platform.js'
import { EventAppendError, EventAppendOutcomeUnknownError, EventLogCorruptionError, FileEventStoreCapabilityError } from './event-store.js'
import { batchName, decodeBatch, encodeBatch } from './file-batch.js'
import { FileEventStore } from './file.js'
import { generateTestAgentId } from '~/core/agents/schema.js'
import { agentEvents } from '~/core/agents/state.js'
import { llmEvents } from '~/core/llm/state.js'

interface Hooks {
	beforeWrite?(path: string, data: string | Uint8Array): Promise<void>
	beforeRename?(source: string, dest: string): Promise<void>
	afterRename?(source: string, dest: string): Promise<void>
	beforeRead?(path: string): Promise<void>
	beforeUnlink?(path: string): Promise<void>
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
		async writeFile(path, data) {
			await hooks.beforeWrite?.(path, data)
			await inner.writeFile(path, data)
		},
		async rename(source, dest) {
			await hooks.beforeRename?.(source, dest)
			await move(source, dest)
			await hooks.afterRename?.(source, dest)
		},
		async unlink(path) {
			await hooks.beforeUnlink?.(path)
			await inner.unlink(path)
		},
	}
}

function gate(): { promise: Promise<void>; release: () => void } {
	let release = () => {}
	const promise = new Promise<void>((resolve) => {
		release = resolve
	})
	return { promise, release }
}

describe('immutable event batches', () => {
	let root: string
	let id: SessionId
	let directory: string
	let batches: string
	let events: DomainEvent[]
	const native = createNodeFileSystem()
	const failure = new Error('injected failure')
	const fresh = (fs = native) => new FileEventStore(root, fs)

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'roj-batches-'))
		id = generateSessionId()
		directory = join(root, 'sessions', id, '.events')
		batches = join(directory, 'batches')
		events = [
			withSessionId(id, sessionEvents.create('session_created', { presetId: 'žluťoučký 🌍' })),
			withSessionId(id, sessionEvents.create('session_closed', {})),
		]
	})

	afterEach(async () => {
		await rm(root, { recursive: true, force: true })
	})

	test('requires rename before any write', () => {
		let writes = 0
		const fs = {
			...native,
			rename: undefined,
			writeFile: async () => {
				writes++
			},
		}
		expect(() => fresh(fs)).toThrow(FileEventStoreCapabilityError)
		expect(writes).toBe(0)
	})

	test('uses a retained bound rename callable', async () => {
		const fs = instrument(native, {})
		const store = fresh(fs)
		fs.rename = async () => {
			throw failure
		}
		await store.appendBatch(id, events)
		expect(await fresh().load(id)).toEqual(events)
	})

	test('one batch is one immutable commit and Unicode checksums count UTF8 bytes', async () => {
		const store = fresh()
		await store.appendBatch(id, events)
		const path = join(batches, batchName(0))
		const content = await readFile(path, 'utf8')
		expect(content).toBe(encodeBatch(0, events))
		expect(decodeBatch(content, 0, id, path)).toEqual(events)
		await store.append(id, events[1])
		expect(await readFile(path, 'utf8')).toBe(content)
		expect((await readdir(batches)).sort()).toEqual([batchName(0), batchName(1)])
		expect(await fresh().load(id)).toEqual([...events, events[1]])
	})

	test('partial pending writes are removed on every warm-store retry', async () => {
		await fresh().append(id, events[0])
		const store = fresh(
			instrument(native, {
				async beforeWrite(path, data) {
					if (!path.startsWith(batches)) return
					await writeFile(path, typeof data === 'string' ? data.slice(0, 25) : data.subarray(0, 25))
					throw failure
				},
			}),
		)
		for (let attempt = 0; attempt < 3; attempt++) {
			await expect(store.appendBatch(id, [events[1], events[1]])).rejects.toBeInstanceOf(EventAppendError)
			expect(await readdir(batches)).toEqual([batchName(0)])
		}
		expect(await fresh().load(id)).toEqual([events[0]])
		const recovered = fresh()
		await recovered.append(id, events[1])
		expect(await recovered.load(id)).toEqual(events)
	})

	test('a complete pending batch is ignored and cleanup is best effort', async () => {
		await mkdir(batches, { recursive: true })
		const pending = join(batches, '.pending-orphan')
		await writeFile(pending, encodeBatch(0, events))
		const store = fresh(
			instrument(native, {
				async beforeUnlink() {
					throw failure
				},
			}),
		)
		expect(await store.load(id)).toEqual([])
		expect(await readFile(pending, 'utf8')).toBe(encodeBatch(0, events))
		await store.appendBatch(id, events)
		expect(await store.load(id)).toEqual(events)
	})

	test('before-rename failure is definite and a retry commits once', async () => {
		let fail = true
		const store = fresh(
			instrument(native, {
				async beforeRename(_source, dest) {
					if (fail && dest.startsWith(batches)) throw failure
				},
			}),
		)
		await expect(store.appendBatch(id, events)).rejects.toBeInstanceOf(EventAppendError)
		expect(await store.load(id)).toEqual([])
		fail = false
		await store.appendBatch(id, events)
		expect(await fresh().load(id)).toEqual(events)
	})

	test('rename then throw is recognized as success by exact final bytes', async () => {
		const store = fresh(
			instrument(native, {
				async afterRename(_source, dest) {
					if (dest.startsWith(batches)) throw failure
				},
			}),
		)
		await store.appendBatch(id, events)
		expect(await store.load(id)).toEqual(events)
		expect((await store.getMetadata(id))?.metrics?.totalEvents).toBe(2)
	})

	for (const committed of [false, true]) {
		test(`unknown rename readback fences writes; fresh recovery sees committed=${committed}`, async () => {
			let readback = false
			let writes = 0
			const store = fresh(
				instrument(native, {
					async beforeWrite() {
						writes++
					},
					async beforeRename(_source, dest) {
						if (dest.startsWith(batches) && !committed) {
							readback = true
							throw failure
						}
					},
					async afterRename(_source, dest) {
						if (dest.startsWith(batches) && committed) {
							readback = true
							throw failure
						}
					},
					async beforeRead(path) {
						if (readback && path.startsWith(batches)) throw Object.assign(new Error('denied'), { code: 'EACCES' })
					},
				}),
			)
			await expect(store.appendBatch(id, events)).rejects.toBeInstanceOf(EventAppendOutcomeUnknownError)
			const before = writes
			readback = false
			await expect(store.appendBatch(id, events)).rejects.toBeInstanceOf(EventAppendOutcomeUnknownError)
			expect(writes).toBe(before)
			const recovered = fresh()
			expect(await recovered.load(id)).toEqual(committed ? events : [])
			await recovered.appendBatch(id, events)
			expect(await recovered.load(id)).toEqual(committed ? [...events, ...events] : events)
		})
	}

	test('unknown append fences cached reads and all recovery pathways until a fresh instance verifies the log', async () => {
		let armed = false
		let denied = false
		let reads = 0
		let writes = 0
		const store = fresh(
			instrument(native, {
				async afterRename(_source, dest) {
					if (armed && dest.startsWith(batches)) {
						denied = true
						throw failure
					}
				},
				async beforeRead(path) {
					reads++
					if (denied && path.startsWith(batches)) throw new Error('readback unavailable')
				},
				async beforeWrite() {
					writes++
				},
			}),
		)
		await store.append(id, events[0])
		expect(await store.getMetadata(id)).toMatchObject({ status: 'active', metrics: { totalEvents: 1 } })
		expect(await store.loadRange(id)).toEqual({ events: [events[0]], fromIndex: 0, toIndex: 0 })
		const metadataBefore = await readFile(join(directory, 'meta.json'), 'utf8')
		armed = true
		await expect(store.append(id, events[1])).rejects.toBeInstanceOf(EventAppendOutcomeUnknownError)
		armed = false
		denied = false
		const readsBefore = reads
		const writesBefore = writes
		const attempts = [
			() => store.loadRange(id, { since: 0 }),
			() => store.getMetadata(id),
			() => store.load(id),
			() => store.exists(id),
			() => store.reconcileMetadata(id, events),
			() => store.updateMetadata(id, { name: 'must not write' }),
			() => store.append(id, events[1]),
			() => store.appendBatch(id, events),
		]
		for (const attempt of attempts) await expect(attempt()).rejects.toBeInstanceOf(EventAppendOutcomeUnknownError)
		// A fenced session is skipped by the listing rather than taking it down for every other one.
		expect(await store.listSessions()).toEqual([id])
		expect((await store.listSessionsWithMetadata()).sessions).toEqual([])
		expect((await store.listSessionsWithMetadata({ status: 'active' })).total).toBe(0)
		expect((await store.listSessionsWithMetadata({ status: 'closed' })).total).toBe(0)
		expect(reads).toBe(readsBefore)
		expect(writes).toBe(writesBefore)
		expect(await readFile(join(directory, 'meta.json'), 'utf8')).toBe(metadataBefore)
		const recovered = fresh()
		expect(await recovered.load(id)).toEqual(events)
		expect(await recovered.loadRange(id, { since: 0 })).toEqual({ events: [events[1]], fromIndex: 1, toIndex: 1 })
		expect(await recovered.getMetadata(id)).toMatchObject({ status: 'closed', metrics: { totalEvents: 2 } })
		expect(await recovered.exists(id)).toBe(true)
		expect(await recovered.listSessions()).toEqual([id])
		expect((await recovered.listSessionsWithMetadata({ status: 'closed' })).sessions).toHaveLength(1)
		await expect(store.getMetadata(id)).rejects.toBeInstanceOf(EventAppendOutcomeUnknownError)
		await expect(store.append(id, events[1])).rejects.toBeInstanceOf(EventAppendOutcomeUnknownError)
	})

	test('different bytes after rename failure are corruption and permanently fence this instance', async () => {
		const store = fresh(
			instrument(native, {
				async afterRename(_source, dest) {
					if (!dest.startsWith(batches)) return
					await writeFile(dest, 'different bytes')
					throw failure
				},
			}),
		)
		await expect(store.appendBatch(id, events)).rejects.toBeInstanceOf(EventLogCorruptionError)
		await expect(store.appendBatch(id, events)).rejects.toBeInstanceOf(EventLogCorruptionError)
		expect(await readFile(join(batches, batchName(0)), 'utf8')).toBe('different bytes')
	})

	test('readers wait for the rename boundary and see the entire batch', async () => {
		const entered = gate()
		const release = gate()
		const store = fresh(
			instrument(native, {
				async beforeRename(_source, dest) {
					if (!dest.startsWith(batches)) return
					entered.release()
					await release.promise
				},
			}),
		)
		const append = store.appendBatch(id, events)
		await entered.promise
		let readFinished = false
		const load = store.load(id).then((value) => {
			readFinished = true
			return value
		})
		const range = store.loadRange(id)
		const metadata = store.getMetadata(id)
		await Promise.resolve()
		expect(readFinished).toBe(false)
		expect((await readdir(batches)).every((name) => name.startsWith('.pending-'))).toBe(true)
		release.release()
		await append
		expect(await load).toEqual(events)
		expect((await range).events).toEqual(events)
		expect((await metadata)?.metrics?.totalEvents).toBe(2)
	})

	for (const failurePoint of ['write', 'rename']) {
		test(`persistent metadata ${failurePoint} failures do not reject commits or hide live/cold ranges`, async () => {
			const seed = fresh()
			await seed.append(id, events[0])
			await seed.updateMetadata(id, { name: 'custom name', tags: ['tag'], custom: { key: 'value' } })
			let fail = true
			const fs = instrument(native, {
				async beforeWrite(path) {
					if (fail && failurePoint === 'write' && path.startsWith(directory) && !path.startsWith(batches)) throw failure
				},
				async beforeRename(_source, dest) {
					if (fail && failurePoint === 'rename' && dest.endsWith('meta.json')) throw failure
				},
			})
			const store = fresh(fs)
			await store.append(id, events[1])
			for (const reader of [store, fresh(fs)]) {
				expect(await reader.loadRange(id, { since: 0 })).toEqual({ events: [events[1]], fromIndex: 1, toIndex: 1 })
				expect(await reader.getMetadata(id)).toMatchObject({
					status: 'closed',
					metrics: { totalEvents: 2 },
					name: 'custom name',
					tags: ['tag'],
					custom: { key: 'value' },
				})
			}
			const stale = sessionMetadataSchema.parse(JSON.parse(await readFile(join(directory, 'meta.json'), 'utf8')))
			expect(stale.metrics?.totalEvents).toBe(1)
			fail = false
			await store.getMetadata(id)
			const repaired = sessionMetadataSchema.parse(JSON.parse(await readFile(join(directory, 'meta.json'), 'utf8')))
			expect(repaired.metrics?.totalEvents).toBe(2)
		})
	}

	test('cold log verification ignores fabricated metadata counters and status', async () => {
		await fresh().appendBatch(id, events)
		const path = join(directory, 'meta.json')
		const metadata = sessionMetadataSchema.parse(JSON.parse(await readFile(path, 'utf8')))
		await writeFile(path, JSON.stringify({ ...metadata, status: 'active', metrics: { ...metadata.metrics, totalEvents: 999 } }))
		const store = fresh()
		expect(await store.loadRange(id, { since: 1 })).toEqual({ events: [], fromIndex: -1, toIndex: 1 })
		expect(await store.getMetadata(id)).toMatchObject({ status: 'closed', metrics: { totalEvents: 2 } })
	})

	test('the first commit succeeds even when metadata can never be created', async () => {
		const fs = instrument(native, {
			async beforeWrite(path) {
				if (!path.startsWith(batches)) throw failure
			},
		})
		const store = fresh(fs)
		await store.appendBatch(id, events)
		for (const reader of [store, fresh(fs)]) {
			expect(await reader.loadRange(id)).toEqual({ events, fromIndex: 0, toIndex: 1 })
			expect(await reader.getMetadata(id)).toMatchObject({ status: 'closed', metrics: { totalEvents: 2 } })
		}
		expect(await native.exists(join(directory, 'meta.json'))).toBe(false)
	})

	test('readable decorations survive otherwise invalid metadata', async () => {
		await fresh().appendBatch(id, events)
		await writeFile(
			join(directory, 'meta.json'),
			JSON.stringify({
				name: 'recover me',
				tags: ['kept'],
				custom: { key: 'value' },
				status: 'invalid',
				metrics: 'broken',
			}),
		)
		expect(await fresh().getMetadata(id)).toMatchObject({
			name: 'recover me',
			tags: ['kept'],
			custom: { key: 'value' },
			status: 'closed',
			metrics: { totalEvents: 2 },
		})
	})

	test('cold metadata IO failure preserves unread decorations and retries without overwriting them', async () => {
		const seed = fresh()
		await seed.appendBatch(id, events)
		await seed.updateMetadata(id, { name: 'original', tags: ['important'], custom: { key: 'preserved' } })
		const metaPath = join(directory, 'meta.json')
		const before = await readFile(metaPath, 'utf8')
		let denied = true
		let writes = 0
		const store = fresh(
			instrument(native, {
				async beforeRead(path) {
					if (denied && path === metaPath) throw Object.assign(new Error('metadata denied'), { code: 'EACCES' })
				},
				async beforeWrite() {
					writes++
				},
			}),
		)
		await expect(store.load(id)).rejects.toThrow('metadata denied')
		await expect(store.getMetadata(id)).rejects.toThrow('metadata denied')
		await expect(store.append(id, events[1])).rejects.toBeInstanceOf(EventAppendError)
		expect(writes).toBe(0)
		expect(await readFile(metaPath, 'utf8')).toBe(before)
		denied = false
		expect(await store.getMetadata(id)).toMatchObject({ name: 'original', tags: ['important'], custom: { key: 'preserved' } })
		await store.append(id, events[1])
		expect(await fresh().getMetadata(id)).toMatchObject({
			name: 'original',
			tags: ['important'],
			custom: { key: 'preserved' },
			metrics: { totalEvents: 3 },
		})
	})

	for (const failurePoint of ['write', 'rename']) {
		test(`explicit metadata ${failurePoint} failure rejects without caching ghost decorations`, async () => {
			const seed = fresh()
			await seed.appendBatch(id, events)
			await seed.updateMetadata(id, { name: 'original', tags: ['original'] })
			let fail = false
			const store = fresh(
				instrument(native, {
					async beforeWrite(path) {
						if (fail && failurePoint === 'write' && !path.startsWith(batches)) throw failure
					},
					async beforeRename(_source, dest) {
						if (fail && failurePoint === 'rename' && dest.endsWith('meta.json')) throw failure
					},
				}),
			)
			await store.getMetadata(id)
			fail = true
			await expect(store.updateMetadata(id, { name: 'ghost', tags: ['ghost'] })).rejects.toThrow()
			expect(await store.getMetadata(id)).toMatchObject({ name: 'original', tags: ['original'] })
			expect(await fresh().getMetadata(id)).toMatchObject({ name: 'original', tags: ['original'] })
			fail = false
			await store.updateMetadata(id, { name: 'confirmed' })
			expect(await fresh().getMetadata(id)).toMatchObject({ name: 'confirmed', tags: ['original'] })
		})
	}

	test('explicit metadata rename then throw succeeds only after exact-byte readback', async () => {
		await fresh().appendBatch(id, events)
		const store = fresh(
			instrument(native, {
				async afterRename(_source, dest) {
					if (dest.endsWith('meta.json')) throw failure
				},
			}),
		)
		await store.updateMetadata(id, { name: 'confirmed by readback' })
		expect(await fresh().getMetadata(id)).toMatchObject({ name: 'confirmed by readback' })
	})

	test('unknown explicit metadata replacement rejects and requires readable decorations before further writes', async () => {
		const seed = fresh()
		await seed.appendBatch(id, events)
		await seed.updateMetadata(id, { name: 'original' })
		let armed = false
		let denied = false
		let writes = 0
		const store = fresh(
			instrument(native, {
				async beforeWrite() {
					writes++
				},
				async afterRename(_source, dest) {
					if (armed && dest.endsWith('meta.json')) {
						denied = true
						throw failure
					}
				},
				async beforeRead(path) {
					if (denied && path.endsWith('meta.json')) throw new Error('readback unavailable')
				},
			}),
		)
		await store.getMetadata(id)
		armed = true
		await expect(store.updateMetadata(id, { name: 'possibly committed' })).rejects.toThrow('readback unavailable')
		const before = writes
		await expect(store.getMetadata(id)).rejects.toThrow('readback unavailable')
		await expect(store.updateMetadata(id, { name: 'blind retry' })).rejects.toThrow('readback unavailable')
		expect(writes).toBe(before)
		armed = false
		denied = false
		expect(await store.getMetadata(id)).toMatchObject({ name: 'possibly committed' })
		expect(await fresh().getMetadata(id)).toMatchObject({ name: 'possibly committed' })
	})

	test('hot appends, metadata and existence checks never reread verified batch contents', async () => {
		await fresh().append(id, events[0])
		const reads: string[] = []
		const store = fresh(
			instrument(native, {
				async beforeRead(path) {
					if (path.startsWith(batches) || path.endsWith('events.jsonl')) reads.push(path)
				},
			}),
		)
		await store.getMetadata(id)
		expect(reads).toContain(join(batches, batchName(0)))
		reads.length = 0
		for (let index = 0; index < 20; index++) {
			await store.append(id, events[1])
			expect((await store.getMetadata(id))?.metrics?.totalEvents).toBe(index + 2)
			expect(await store.exists(id)).toBe(true)
		}
		expect(reads).toEqual([])
		expect(await store.loadRange(id, { since: 19, limit: 1 })).toEqual({ events: [events[1]], fromIndex: 20, toIndex: 20 })
		expect(reads).toEqual([join(batches, batchName(20))])
		reads.length = 0
		expect(await store.loadRange(id, { since: 20 })).toEqual({ events: [], fromIndex: -1, toIndex: 20 })
		expect(reads).toEqual([])
		expect(await store.getMetadata(id)).toEqual(await fresh().getMetadata(id))
	})

	test('indexed ranges cross the legacy prefix and batch boundaries correctly', async () => {
		await mkdir(directory, { recursive: true })
		await writeFile(join(directory, 'events.jsonl'), JSON.stringify(events[0]))
		const reopened = withSessionId(id, sessionEvents.create('session_reopened', {}))
		const store = fresh()
		await store.appendBatch(id, [events[1], reopened])
		await store.append(id, events[1])
		expect(await store.loadRange(id, { limit: 2 })).toEqual({ events, fromIndex: 0, toIndex: 1 })
		expect(await store.loadRange(id, { since: 1, limit: 2 })).toEqual({ events: [reopened, events[1]], fromIndex: 2, toIndex: 3 })
		expect(await store.getMetadata(id)).toEqual(await fresh().getMetadata(id))
	})

	test('incremental metadata matches cold reconstruction across metrics and status changes', async () => {
		const store = fresh()
		const agentId = generateTestAgentId()
		const spawn = withSessionId(id, agentEvents.create('agent_spawned', { agentId, definitionName: 'test', parentId: null }))
		const inference = withSessionId(
			id,
			llmEvents.create('inference_completed', {
				agentId,
				consumedMessageIds: [],
				response: { content: 'test', toolCalls: [] },
				metrics: { promptTokens: 100, completionTokens: 50, totalTokens: 150, latencyMs: 500, model: 'test', cost: 0.25 },
			}),
		)
		await store.append(id, events[0])
		await store.appendBatch(id, [spawn, inference, events[1]])
		await store.append(id, withSessionId(id, sessionEvents.create('session_reopened', {})))
		await store.append(id, inference)
		expect(await store.getMetadata(id)).toMatchObject({
			status: 'active',
			metrics: { totalEvents: 6, totalAgents: 1, totalTokens: 300, inputTokens: 200, outputTokens: 100, totalLLMCalls: 2, totalCost: 0.5 },
		})
		expect(await store.getMetadata(id)).toEqual(await fresh().getMetadata(id))
	})

	test('the closed-session guard runs after the preceding append', async () => {
		const store = fresh()
		await store.append(id, events[0])
		const close = store.append(id, events[1])
		const hook = store.append(
			id,
			withSessionId(
				id,
				sessionEvents.create('session_handler_started', {
					handlerName: 'onSessionReady',
					pluginName: 'test',
				}),
			),
		)
		await close
		await expect(hook).rejects.toThrow('Refusing to append')
		expect(await store.load(id)).toEqual(events)
	})

	for (const trailingNewline of [false, true]) {
		test(`legacy prefix is unchanged with trailing newline=${trailingNewline}`, async () => {
			await mkdir(directory, { recursive: true })
			const path = join(directory, 'events.jsonl')
			const legacy = JSON.stringify(events[0]) + (trailingNewline ? '\n' : '')
			await writeFile(path, legacy)
			const store = fresh()
			await store.append(id, events[1])
			expect(await fresh().load(id)).toEqual(events)
			expect(await readFile(path, 'utf8')).toBe(legacy)
		})
	}

	test('malformed legacy fails explicitly and is never repaired or appended to', async () => {
		await mkdir(directory, { recursive: true })
		const path = join(directory, 'events.jsonl')
		const legacy = `${JSON.stringify(events[0])}\n{"type":`
		await writeFile(path, legacy)
		const store = fresh()
		await expect(store.load(id)).rejects.toBeInstanceOf(EventLogCorruptionError)
		await expect(store.append(id, events[1])).rejects.toBeInstanceOf(EventLogCorruptionError)
		expect(await readFile(path, 'utf8')).toBe(legacy)
		expect(await readdir(directory)).toEqual(['events.jsonl'])
	})

	test('checksum corruption is not skipped or deleted', async () => {
		await fresh().appendBatch(id, events)
		const path = join(batches, batchName(0))
		const content = (await readFile(path, 'utf8')).replace('žluťoučký', 'xxxxxxxxx')
		await writeFile(path, content)
		const store = fresh()
		await expect(store.loadRange(id)).rejects.toBeInstanceOf(EventLogCorruptionError)
		await expect(store.append(id, events[1])).rejects.toBeInstanceOf(EventLogCorruptionError)
		expect(await readFile(path, 'utf8')).toBe(content)
	})

	test('a batch gap fails without deleting any committed file', async () => {
		const store = fresh()
		await store.append(id, events[0])
		await store.append(id, events[1])
		await rename(join(batches, batchName(1)), join(batches, batchName(2)))
		await expect(fresh().load(id)).rejects.toBeInstanceOf(EventLogCorruptionError)
		expect((await readdir(batches)).sort()).toEqual([batchName(0), batchName(2)])
	})

	test('rejects invalid envelopes, mismatched sessions, empty batches and unsafe sequence numbers', () => {
		const path = 'test-batch'
		expect(() => decodeBatch(encodeBatch(0, []), 0, id, path)).toThrow(EventLogCorruptionError)
		expect(() => decodeBatch(encodeBatch(1, events), 0, id, path)).toThrow(EventLogCorruptionError)
		expect(() => decodeBatch(encodeBatch(0, events), 0, generateSessionId(), path)).toThrow(EventLogCorruptionError)
		expect(() => decodeBatch('{"version":2}', 0, id, path)).toThrow(EventLogCorruptionError)
		expect(() => batchName(Number.MAX_SAFE_INTEGER + 1)).toThrow()
		expect(batchName(Number.MAX_SAFE_INTEGER)).toBe('001fffffffffffff.json')
	})

	test('a foreign file in the batch directory is not a missing batch', async () => {
		const store = fresh()
		await store.appendBatch(id, events)
		// The shapes a pod pool over shared storage produces on its own.
		for (const name of ['.DS_Store', '.nfs00000000004a1c2200000003', 'events.json.swp'])
			await writeFile(join(batches, name), 'not a batch')
		const recovered = fresh()
		expect(await recovered.load(id)).toEqual(events)
		expect(await recovered.listSessions()).toEqual([id])
		expect(await store.append(id, events[1])).toBeUndefined()
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
			...Array.from({ length: 20 }, () => store.append(id, events[1])),
			store.updateMetadata(id, { name: 'concurrent', tags: ['kept'] }),
		])
		expect(await store.load(id)).toHaveLength(21)
		expect(await fresh().getMetadata(id)).toMatchObject({ metrics: { totalEvents: 21 }, name: 'concurrent', tags: ['kept'] })
	})
})
