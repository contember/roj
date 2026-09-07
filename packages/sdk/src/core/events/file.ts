import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import z from 'zod/v4'
import type { DomainEvent } from './types.js'
import { isValidSessionId, SessionId, sessionMetadataSchema } from '~/core/sessions/schema.js'
import type { SessionMetadata } from '~/core/sessions/schema.js'
import type { FileSystem } from '~/platform/fs.js'
import { silentLogger, type Logger } from '~/lib/logger/logger.js'
import { BaseEventStore } from './base-event-store.js'
import { EventAppendError, EventAppendOutcomeUnknownError, EventLogCorruptionError, FileEventStoreCapabilityError } from './event-store.js'
import type { LoadRangeOptions, LoadRangeResult } from './event-store.js'
import { batchName, decodeBatch, encodeBatch, parseEvent } from './file-batch.js'
import { computeMetadataFromEvents, computeMetricsFromEvents } from './metadata-utils.js'

function isNotFound(error: unknown): boolean {
	return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

const decorationsSchema = z.object({
	name: sessionMetadataSchema.shape.name.catch(undefined),
	tags: sessionMetadataSchema.shape.tags.catch(undefined),
	custom: sessionMetadataSchema.shape.custom.catch(undefined),
})

interface VerifiedSession {
	totalEvents: number
	legacyCount: number
	batches: Array<{ start: number; count: number }>
	computed: SessionMetadata | null
}

/** Single writer instance per session. Rename is the commit boundary, not an fsync guarantee.
 * Legacy JSONL is read-only; SDK downgrade is unsupported after the first batch commit. */
export class FileEventStore extends BaseEventStore {
	private readonly rename: (source: string, dest: string) => Promise<void>
	private readonly metadata = new Map<SessionId, SessionMetadata | null>()
	private readonly verifiedSessions = new Map<SessionId, VerifiedSession>()
	private readonly dirty = new Set<SessionId>()
	private readonly fenced = new Map<SessionId, EventAppendOutcomeUnknownError | EventLogCorruptionError>()

	constructor(
		private readonly basePath: string,
		private readonly fs: FileSystem,
		private readonly logger: Logger = silentLogger,
	) {
		super()
		const rename = fs.rename
		if (typeof rename !== 'function') throw new FileEventStoreCapabilityError()
		this.rename = rename.bind(fs)
	}

	private directory(sessionId: SessionId): string {
		return join(this.basePath, 'sessions', sessionId, '.events')
	}

	private async names(path: string): Promise<string[]> {
		try {
			return await this.fs.readdir(path)
		} catch (error) {
			if (isNotFound(error)) return []
			throw error
		}
	}

	private async cleanup(path: string, names: string[]): Promise<void> {
		for (const name of names) {
			if (name.startsWith('.pending-')) await this.fs.unlink(join(path, name)).catch(() => {})
		}
	}

	private async readLogFile(sessionId: SessionId, path: string): Promise<string> {
		const bytes = await this.fs.readFile(path)
		const content = bytes.toString('utf8')
		if (!Buffer.from(content, 'utf8').equals(bytes)) {
			throw new EventLogCorruptionError(sessionId, path, new Error('Invalid UTF8'))
		}
		return content
	}

	private async readLegacy(sessionId: SessionId): Promise<DomainEvent[]> {
		const path = join(this.directory(sessionId), 'events.jsonl')
		let content: string
		try {
			content = await this.readLogFile(sessionId, path)
		} catch (error) {
			if (isNotFound(error)) return []
			throw error
		}
		try {
			return content
				.split('\n')
				.filter((line) => line.trim())
				.map((line) => parseEvent(JSON.parse(line), sessionId))
		} catch (cause) {
			throw new EventLogCorruptionError(sessionId, path, cause)
		}
	}

	private async readBatch(sessionId: SessionId, index: number): Promise<DomainEvent[]> {
		const path = join(this.directory(sessionId), 'batches', batchName(index))
		try {
			return decodeBatch(await this.readLogFile(sessionId, path), index, sessionId, path)
		} catch (cause) {
			if (isNotFound(cause)) throw new EventLogCorruptionError(sessionId, path, cause)
			throw cause
		}
	}

	private async recover(sessionId: SessionId): Promise<{ events: DomainEvent[]; state: VerifiedSession }> {
		this.assertUnfenced(sessionId)
		const directory = this.directory(sessionId)
		try {
			const events = await this.readLegacy(sessionId)
			const state: VerifiedSession = { totalEvents: 0, legacyCount: events.length, batches: [], computed: null }
			const batches = join(directory, 'batches')
			const names = await this.names(batches)
			const committed = names.filter((name) => !name.startsWith('.pending-')).sort()
			for (const [index, name] of committed.entries()) {
				const path = join(batches, name)
				if (name !== batchName(index)) throw new EventLogCorruptionError(sessionId, path, new Error('Non-contiguous batch sequence'))
				const batch = await this.readBatch(sessionId, index)
				state.batches.push({ start: events.length, count: batch.length })
				for (const event of batch) events.push(event)
			}
			await this.cleanup(batches, names)
			await this.cleanup(directory, await this.names(directory))
			state.totalEvents = events.length
			const computed = sessionMetadataSchema.safeParse(computeMetadataFromEvents(sessionId, events))
			state.computed = computed.success ? computed.data : null
			if (events.length) this.verifiedSessions.set(sessionId, state)
			else this.verifiedSessions.delete(sessionId)
			await this.refreshMetadata(sessionId, state)
			return { events, state }
		} catch (error) {
			if (error instanceof EventLogCorruptionError) this.fenced.set(sessionId, error)
			throw error
		}
	}

	private async verified(sessionId: SessionId): Promise<VerifiedSession> {
		this.assertUnfenced(sessionId)
		const state = this.verifiedSessions.get(sessionId)
		if (!state) return (await this.recover(sessionId)).state
		await this.refreshMetadata(sessionId, state)
		return state
	}

	private extendMetadata(sessionId: SessionId, state: VerifiedSession, events: DomainEvent[]): SessionMetadata | null {
		if (state.totalEvents === 0) return computeMetadataFromEvents(sessionId, events)
		const previous = state.computed
		if (!previous?.metrics) return null
		const delta = computeMetricsFromEvents(events)
		const metrics = previous.metrics
		let status = previous.status
		for (const event of events) {
			if (event.type === 'session_closed') status = 'closed'
			if (event.type === 'session_reopened') status = 'active'
		}
		return {
			...previous,
			status,
			lastActivityAt: events[events.length - 1].timestamp,
			metrics: {
				totalEvents: metrics.totalEvents + delta.totalEvents,
				totalAgents: metrics.totalAgents + delta.totalAgents,
				totalTokens: metrics.totalTokens + delta.totalTokens,
				totalLLMCalls: metrics.totalLLMCalls + delta.totalLLMCalls,
				inputTokens: (metrics.inputTokens ?? 0) + (delta.inputTokens ?? 0),
				outputTokens: (metrics.outputTokens ?? 0) + (delta.outputTokens ?? 0),
				totalCost: (metrics.totalCost ?? 0) + (delta.totalCost ?? 0),
				totalMessages: (metrics.totalMessages ?? 0) + (delta.totalMessages ?? 0),
				totalToolCalls: (metrics.totalToolCalls ?? 0) + (delta.totalToolCalls ?? 0),
			},
		}
	}

	protected async doAppend(sessionId: SessionId, event: DomainEvent): Promise<void> {
		return this.doAppendBatch(sessionId, [event])
	}

	protected async doAppendBatch(sessionId: SessionId, events: DomainEvent[]): Promise<void> {
		this.assertUnfenced(sessionId)
		let state: VerifiedSession
		let content: string
		let final: string
		let pending: string
		let committedEvents: DomainEvent[]
		let computed: SessionMetadata | null
		try {
			state = await this.verified(sessionId)
			content = encodeBatch(state.batches.length, events)
			committedEvents = decodeBatch(content, state.batches.length, sessionId, 'new batch')
			const parsed = sessionMetadataSchema.safeParse(this.extendMetadata(sessionId, state, committedEvents))
			computed = parsed.success ? parsed.data : null
			const directory = join(this.directory(sessionId), 'batches')
			final = join(directory, batchName(state.batches.length))
			pending = join(directory, `.pending-${randomUUID()}`)
			await this.fs.mkdir(directory, { recursive: true })
			await this.fs.writeFile(pending, content)
		} catch (cause) {
			if (this.fenced.has(sessionId)) throw cause
			throw new EventAppendError(sessionId, cause)
		}
		try {
			await this.rename(pending, final)
		} catch (cause) {
			let actual: Buffer
			try {
				actual = await this.fs.readFile(final)
			} catch (readError) {
				if (isNotFound(readError)) throw new EventAppendError(sessionId, cause)
				const unknown = new EventAppendOutcomeUnknownError(sessionId, readError)
				this.fenced.set(sessionId, unknown)
				throw unknown
			}
			if (!actual.equals(Buffer.from(content, 'utf8'))) {
				const corruption = new EventLogCorruptionError(sessionId, final, cause)
				this.fenced.set(sessionId, corruption)
				throw corruption
			}
		}
		state.batches.push({ start: state.totalEvents, count: committedEvents.length })
		state.totalEvents += committedEvents.length
		state.computed = computed
		this.verifiedSessions.set(sessionId, state)
		// A derived metadata failure cannot undo a confirmed event commit.
		await this.refreshMetadata(sessionId, state).catch(() => {
			this.dirty.add(sessionId)
		})
	}

	async load(sessionId: SessionId): Promise<DomainEvent[]> {
		return this.serialize(sessionId, async () => (await this.recover(sessionId)).events)
	}

	async loadRange(sessionId: SessionId, options?: LoadRangeOptions): Promise<LoadRangeResult> {
		return this.serialize(sessionId, async () => {
			const state = await this.verified(sessionId)
			const start = (options?.since ?? -1) + 1
			const end = Math.min(state.totalEvents, options?.limit === undefined ? state.totalEvents : start + options.limit)
			const events: DomainEvent[] = []
			try {
				if (start < state.legacyCount && end > start) {
					for (const event of (await this.readLegacy(sessionId)).slice(start, end)) events.push(event)
				}
				for (const [index, batch] of state.batches.entries()) {
					if (batch.start >= end) break
					if (batch.start + batch.count <= start) continue
					const selected = (await this.readBatch(sessionId, index)).slice(Math.max(0, start - batch.start), end - batch.start)
					for (const event of selected) events.push(event)
				}
			} catch (error) {
				if (error instanceof EventLogCorruptionError) this.fenced.set(sessionId, error)
				throw error
			}
			return { events, fromIndex: events.length ? start : -1, toIndex: events.length ? start + events.length - 1 : state.totalEvents - 1 }
		})
	}

	async exists(sessionId: SessionId): Promise<boolean> {
		return this.serialize(sessionId, async () => (await this.verified(sessionId)).totalEvents > 0)
	}

	async listSessions(): Promise<SessionId[]> {
		try {
			const ids = (await this.fs.readdir(join(this.basePath, 'sessions'), { withFileTypes: true }))
				.filter((entry) => entry.isDirectory() && isValidSessionId(entry.name))
				.map((entry) => SessionId(entry.name))
			await Promise.all(ids.map((id) => this.serialize(id, async () => this.assertUnfenced(id))))
			return ids
		} catch (error) {
			if (isNotFound(error)) return []
			throw error
		}
	}

	private async refreshMetadata(sessionId: SessionId, state: VerifiedSession): Promise<void> {
		let stored = this.metadata.get(sessionId)
		let decorations: Pick<SessionMetadata, 'name' | 'tags' | 'custom'> = stored ?? {}
		if (stored === undefined) {
			let content: string | undefined
			try {
				content = await this.fs.readFile(join(this.directory(sessionId), 'meta.json'), 'utf8')
			} catch (error) {
				if (!isNotFound(error)) throw error
			}
			let raw: unknown
			try {
				raw = content === undefined ? undefined : JSON.parse(content)
			} catch {
				raw = undefined
			}
			const parsed = sessionMetadataSchema.safeParse(raw)
			stored = parsed.success ? parsed.data : null
			const parsedDecorations = decorationsSchema.safeParse(raw)
			decorations = parsedDecorations.success ? parsedDecorations.data : {}
		}
		const authoritative = state.computed
			? { ...state.computed, name: decorations.name, tags: decorations.tags, custom: decorations.custom }
			: null
		if (state.totalEvents || stored) this.metadata.set(sessionId, authoritative)
		if (JSON.stringify(authoritative) !== JSON.stringify(stored)) this.dirty.add(sessionId)
		if (authoritative && this.dirty.has(sessionId)) {
			try {
				await this.persistMetadata(sessionId, authoritative)
				this.dirty.delete(sessionId)
			} catch (error) {
				this.logger.warn('Session metadata remains dirty', { sessionId, reason: String(error) })
			}
		}
	}

	async getMetadata(sessionId: SessionId): Promise<SessionMetadata | null> {
		return this.serialize(sessionId, () => this.readMetadata(sessionId))
	}

	private assertUnfenced(sessionId: SessionId): void {
		const fence = this.fenced.get(sessionId)
		if (fence) throw fence
	}

	protected async guardWriteToClosed(sessionId: SessionId, events: DomainEvent[]): Promise<void> {
		this.assertUnfenced(sessionId)
		await super.guardWriteToClosed(sessionId, events)
	}

	protected async mergeMetadata(sessionId: SessionId, update: Partial<SessionMetadata>): Promise<void> {
		this.assertUnfenced(sessionId)
		await super.mergeMetadata(sessionId, update)
	}

	protected async readMetadata(sessionId: SessionId): Promise<SessionMetadata | null> {
		await this.verified(sessionId)
		return structuredClone(this.metadata.get(sessionId) ?? null)
	}

	protected async writeMetadata(sessionId: SessionId, metadata: SessionMetadata): Promise<void> {
		const snapshot = structuredClone(metadata)
		await this.persistMetadata(sessionId, snapshot, true)
		this.metadata.set(sessionId, snapshot)
		this.dirty.delete(sessionId)
	}

	private async persistMetadata(sessionId: SessionId, metadata: SessionMetadata, explicit = false): Promise<void> {
		const directory = this.directory(sessionId)
		const pending = join(directory, `.pending-${randomUUID()}`)
		const final = join(directory, 'meta.json')
		const content = JSON.stringify(metadata)
		try {
			await this.fs.mkdir(directory, { recursive: true })
			await this.fs.writeFile(pending, content)
			try {
				await this.rename(pending, final)
			} catch (error) {
				// An unconfirmed explicit replacement must be re-read before decorations can be used again.
				if (explicit) this.metadata.delete(sessionId)
				const actual = await this.fs.readFile(final)
				if (!actual.equals(Buffer.from(content, 'utf8'))) throw error
			}
		} finally {
			await this.fs.unlink(pending).catch(() => {})
		}
	}

	async reconcileMetadata(sessionId: SessionId, _events: DomainEvent[]): Promise<boolean> {
		return this.serialize(sessionId, async () => {
			const before = JSON.stringify(this.metadata.get(sessionId))
			await this.recover(sessionId)
			return before !== JSON.stringify(this.metadata.get(sessionId))
		})
	}

	protected async getAllSessionMetadata(): Promise<SessionMetadata[]> {
		const ids = await this.listSessions()
		const present = new Set(ids)
		for (const id of new Set([...this.metadata.keys(), ...this.verifiedSessions.keys()])) {
			if (!present.has(id)) {
				await this.serialize(id, async () => {
					try {
						await this.fs.stat(this.directory(id))
					} catch (error) {
						if (!isNotFound(error)) throw error
						this.metadata.delete(id)
						this.verifiedSessions.delete(id)
						this.dirty.delete(id)
					}
				})
			}
		}
		const results = await Promise.all(ids.map((id) => this.getMetadata(id)))
		return results.filter((value): value is SessionMetadata => value !== null)
	}
}
