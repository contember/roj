import { dirname, join } from 'node:path'
import z from 'zod/v4'
import type { DomainEvent } from '~/core/events/types.js'
import { silentLogger, type Logger } from '~/lib/logger/logger.js'
import type { Dirent, FileSystem } from '~/platform/fs.js'
import { domainEventSchema, isValidSessionId, SessionId, sessionMetadataSchema } from '~/core/sessions/schema.js'
import type { SessionMetadata } from '~/core/sessions/schema.js'
import { BaseEventStore } from './base-event-store.js'
import type { LoadRangeOptions, LoadRangeResult } from './event-store.js'
import { EventAppendError, EventStoreError } from './event-store.js'

/**
 * Simple async mutex for serializing access to a shared resource.
 * Used to prevent concurrent writes to the same session's event file.
 */
class AsyncMutex {
	private locked = false
	private queue: Array<() => void> = []

	async acquire(): Promise<void> {
		if (!this.locked) {
			this.locked = true
			return
		}

		return new Promise<void>((resolve) => {
			this.queue.push(resolve)
		})
	}

	release(): void {
		const next = this.queue.shift()
		if (next) {
			next()
		} else {
			this.locked = false
		}
	}

	async withLock<T>(fn: () => Promise<T>): Promise<T> {
		await this.acquire()
		try {
			return await fn()
		} finally {
			this.release()
		}
	}
}

/**
 * Read last N lines from a file efficiently by reading chunks from the end.
 * Returns lines in order (oldest first).
 */
async function readLastLines(fs: FileSystem, filePath: string, lineCount: number): Promise<string[]> {
	if (lineCount <= 0) return []

	const file = await fs.open(filePath, 'r')
	try {
		const stats = await file.stat()
		const fileSize = stats.size

		if (fileSize === 0) return []

		const chunkSize = 8192 // 8KB chunks
		let position = fileSize
		let buffer = ''
		const lines: string[] = []

		while (position > 0 && lines.length < lineCount) {
			const readSize = Math.min(chunkSize, position)
			position -= readSize

			const chunk = Buffer.alloc(readSize)
			await file.read(chunk, 0, readSize, position)

			buffer = chunk.toString('utf-8') + buffer

			// Extract complete lines from buffer
			const parts = buffer.split('\n')
			buffer = parts[0] // Keep incomplete first part

			// Add complete lines (in reverse, from end)
			for (let i = parts.length - 1; i > 0; i--) {
				const line = parts[i].trim()
				if (line) {
					lines.unshift(line) // Add to front to maintain order
					if (lines.length >= lineCount) break
				}
			}
		}

		// Handle remaining buffer (first line of file)
		if (buffer.trim() && lines.length < lineCount) {
			lines.unshift(buffer.trim())
		}

		return lines.slice(-lineCount) // Ensure we don't return more than requested
	} finally {
		await file.close()
	}
}

/** Identity of the meta.json bytes a cached verdict was taken from. */
interface MetadataSource {
	mtimeMs: number
	size: number
}

/** A parsed record, or the verdict that the bytes it was read from do not parse. */
type MetadataCacheEntry =
	| { kind: 'record'; record: SessionMetadata }
	| { kind: 'invalid'; source: MetadataSource }

function isSameSource(a: MetadataSource, b: MetadataSource): boolean {
	return a.mtimeMs === b.mtimeMs && a.size === b.size
}

function errorCode(error: unknown): string | undefined {
	return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

function isNotFound(error: unknown): boolean {
	return errorCode(error) === 'ENOENT'
}

/** Before the cache every read parsed fresh JSON — keep that, so a mutating caller cannot corrupt it. */
function copyMetadata(metadata: SessionMetadata | null): SessionMetadata | null {
	if (!metadata) return null

	const copy: SessionMetadata = { ...metadata }
	if (metadata.metrics) copy.metrics = { ...metadata.metrics }
	if (metadata.tags) copy.tags = [...metadata.tags]
	if (metadata.custom) copy.custom = { ...metadata.custom }
	return copy
}

/**
 * FileEventStore - Persists domain events to JSONL files.
 *
 * File structure:
 * ```
 * {basePath}/
 *   sessions/
 *     {sessionId}/
 *       .events/
 *         events.jsonl
 *         meta.json
 *         uploads/
 *         calls/
 *       (agent workspace files)
 * ```
 *
 * Each line in events.jsonl is a JSON-serialized domain event.
 * meta.json contains session metadata for quick access.
 */
export class FileEventStore extends BaseEventStore {
	private readonly sessionLocks = new Map<SessionId, AsyncMutex>()

	/**
	 * Parsed meta.json per session, so a `/status` poll costs one readdir instead of
	 * one readFile per session directory that ever existed. An `invalid` entry records
	 * bytes that exist but do not parse, so a corrupt record is reported once rather
	 * than once per poll, and is re-read as soon as those bytes change.
	 *
	 * Coherence rule: writes win. writeMetadata is the only writer, and a read stores
	 * its result only if the entry did not move while the read was in flight — a read
	 * is a snapshot of older bytes, so it must never overwrite a newer write. A full
	 * listing prunes the map to the readdir set, which keeps deletion and out-of-band
	 * creation self-healing.
	 */
	private readonly metadataCache = new Map<SessionId, MetadataCacheEntry>()

	/** Last reported read failure per session, so a permanent EACCES is not logged on every poll. */
	private readonly reportedReadFailures = new Map<SessionId, string>()

	constructor(
		private readonly basePath: string,
		private readonly fs: FileSystem,
		private readonly logger: Logger = silentLogger,
	) {
		super()
	}

	/**
	 * Get or create a mutex for a specific session.
	 * Ensures serialized access to each session's event file.
	 */
	private getLock(sessionId: SessionId): AsyncMutex {
		let lock = this.sessionLocks.get(sessionId)
		if (!lock) {
			lock = new AsyncMutex()
			this.sessionLocks.set(sessionId, lock)
		}
		return lock
	}

	private getSessionDir(sessionId: SessionId): string {
		return join(this.basePath, 'sessions', sessionId)
	}

	private getEventsDir(sessionId: SessionId): string {
		return join(this.getSessionDir(sessionId), '.events')
	}

	private getEventsPath(sessionId: SessionId): string {
		return join(this.getEventsDir(sessionId), 'events.jsonl')
	}

	private getMetaPath(sessionId: SessionId): string {
		return join(this.getEventsDir(sessionId), 'meta.json')
	}

	protected async doAppend(sessionId: SessionId, event: DomainEvent): Promise<void> {
		const lock = this.getLock(sessionId)

		await lock.withLock(async () => {
			const path = this.getEventsPath(sessionId)

			try {
				// Ensure directory exists
				await this.fs.mkdir(dirname(path), { recursive: true })

				// Append event as JSON line
				const line = JSON.stringify(event) + '\n'
				await this.fs.appendFile(path, line)

				// Update metadata
				await this.updateMetadataFromEvents(sessionId, [event])
			} catch (error) {
				throw new EventAppendError(sessionId, error)
			}
		})
	}

	protected async doAppendBatch(sessionId: SessionId, events: DomainEvent[]): Promise<void> {
		if (events.length === 0) return

		const lock = this.getLock(sessionId)

		await lock.withLock(async () => {
			const path = this.getEventsPath(sessionId)

			try {
				// Ensure directory exists
				await this.fs.mkdir(dirname(path), { recursive: true })

				// Append all events as JSON lines
				const content = events.map((e) => JSON.stringify(e)).join('\n') + '\n'
				await this.fs.appendFile(path, content)

				// Update metadata in a single batch
				await this.updateMetadataFromEvents(sessionId, events)
			} catch (error) {
				throw new EventAppendError(sessionId, error)
			}
		})
	}

	async load(sessionId: SessionId): Promise<DomainEvent[]> {
		const path = this.getEventsPath(sessionId)

		try {
			const content = await this.fs.readFile(path, 'utf-8')
			const lines = content.split('\n').filter((line) => line.trim())

			return lines.map((line, index) => {
				try {
					const parsed = JSON.parse(line)
					// Validate with Zod to ensure basic structure integrity
					// The schema uses passthrough(), so unknown properties are preserved
					const validated = domainEventSchema.parse(parsed)
					return validated as unknown as DomainEvent
				} catch (parseError) {
					throw new EventStoreError(
						`Failed to parse event at line ${index + 1}`,
						sessionId,
						parseError,
					)
				}
			})
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return []
			}
			if (error instanceof EventStoreError) {
				throw error
			}
			throw new EventStoreError('Failed to load events', sessionId, error)
		}
	}

	async exists(sessionId: SessionId): Promise<boolean> {
		return this.fs.exists(this.getEventsPath(sessionId))
	}

	async listSessions(): Promise<SessionId[]> {
		const sessionsDir = join(this.basePath, 'sessions')

		try {
			const entries = await this.fs.readdir(sessionsDir, { withFileTypes: true })
			// A directory whose name is not a valid id is not a session — the metadata listing drops it too.
			return entries
				.filter((entry) => entry.isDirectory() && isValidSessionId(entry.name))
				.map((entry) => SessionId(entry.name))
		} catch (error) {
			if (isNotFound(error)) {
				return []
			}
			throw error
		}
	}

	async loadRange(
		sessionId: SessionId,
		options?: LoadRangeOptions,
	): Promise<LoadRangeResult> {
		const since = options?.since ?? -1
		const limit = options?.limit

		// Get total event count from metadata
		const metadata = await this.getMetadata(sessionId)
		const totalEvents = metadata?.metrics?.totalEvents ?? 0

		// toIndex always reflects the actual last event in the store (for polling cursor)
		const storeLastIndex = totalEvents - 1

		// Early return: no new events
		if (since >= totalEvents - 1) {
			return { events: [], fromIndex: -1, toIndex: storeLastIndex }
		}

		// Calculate how many events we need from the end
		const fromIndex = since + 1
		const availableCount = totalEvents - fromIndex
		const neededCount = limit !== undefined ? Math.min(limit, availableCount) : availableCount

		// Use full load when we need most events OR when the range doesn't extend to the end
		// (partial read always reads from the end, so it's wrong if limit causes a gap)
		const rangeExtendsToEnd = fromIndex + neededCount >= totalEvents
		if (neededCount > totalEvents * 0.5 || !rangeExtendsToEnd) {
			const allEvents = await this.load(sessionId)
			const events = allEvents.slice(
				fromIndex,
				limit ? fromIndex + limit : undefined,
			)
			return {
				events,
				fromIndex: events.length > 0 ? fromIndex : -1,
				toIndex: events.length > 0 ? fromIndex + events.length - 1 : storeLastIndex,
			}
		}

		// Read last N lines from file
		const path = this.getEventsPath(sessionId)
		try {
			const lines = await readLastLines(this.fs, path, neededCount)

			// Parse events
			const events: DomainEvent[] = []
			for (const line of lines) {
				const parsed = JSON.parse(line)
				const validated = domainEventSchema.parse(parsed)
				events.push(validated as unknown as DomainEvent)
			}

			const actualFromIndex = storeLastIndex - events.length + 1

			return {
				events,
				fromIndex: events.length > 0 ? actualFromIndex : -1,
				toIndex: storeLastIndex,
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return { events: [], fromIndex: -1, toIndex: -1 }
			}
			throw new EventStoreError('Failed to load events range', sessionId, error)
		}
	}

	// =========================================================================
	// Metadata storage primitives
	// =========================================================================

	protected async readMetadata(sessionId: SessionId): Promise<SessionMetadata | null> {
		const cached = this.metadataCache.get(sessionId)
		if (cached?.kind === 'record') return copyMetadata(cached.record)

		const path = this.getMetaPath(sessionId)

		try {
			// Stat before the read, so a verdict is never keyed to bytes newer than the ones it judged.
			const source = await this.readMetadataSource(path)
			// A rejected record stays rejected only for the bytes that were rejected, so a repair is picked up.
			if (cached && isSameSource(cached.source, source)) return null

			const content = await this.fs.readFile(path, 'utf-8')
			const record = this.parseMetadata(sessionId, content)
			this.reportedReadFailures.delete(sessionId)

			return copyMetadata(
				this.commitRead(sessionId, cached, record ? { kind: 'record', record } : { kind: 'invalid', source }),
			)
		} catch (error) {
			if (isNotFound(error)) {
				// A missing file is never cached — unknown ids must not be able to grow the map.
				return null
			}
			this.reportReadFailure(sessionId, error)
			throw error
		}
	}

	/**
	 * Cache what the read found, unless a write landed while it was in flight.
	 *
	 * A read only ever sees the bytes it started from, so the concurrent writer holds the
	 * newer record and the reader reports that one instead of overwriting it with its own.
	 */
	private commitRead(
		sessionId: SessionId,
		before: MetadataCacheEntry | undefined,
		entry: MetadataCacheEntry,
	): SessionMetadata | null {
		const current = this.metadataCache.get(sessionId)
		if (current !== before) return current?.kind === 'record' ? current.record : null

		this.metadataCache.set(sessionId, entry)
		return entry.kind === 'record' ? entry.record : null
	}

	private async readMetadataSource(path: string): Promise<MetadataSource> {
		const stats = await this.fs.stat(path)
		return { mtimeMs: stats.mtimeMs, size: stats.size }
	}

	/** Reports a read that failed for anything but a missing file, once per failure kind. */
	private reportReadFailure(sessionId: SessionId, error: unknown): void {
		const code = errorCode(error) ?? 'unknown'
		if (this.reportedReadFailures.get(sessionId) === code) return

		this.reportedReadFailures.set(sessionId, code)
		this.logger.error(
			'Failed to read session metadata',
			error instanceof Error ? error : new Error(String(error)),
			{ sessionId },
		)
	}

	/**
	 * Strict on write, tolerant on read.
	 *
	 * meta.json is written non-atomically and its schema tightened over time, so a
	 * single truncated or legacy record must not take the whole listing down with it.
	 */
	private parseMetadata(sessionId: SessionId, content: string): SessionMetadata | null {
		let raw: unknown
		try {
			raw = JSON.parse(content)
		} catch (error) {
			this.logger.warn('Skipping unreadable session metadata', { sessionId, reason: String(error) })
			return null
		}

		const parsed = sessionMetadataSchema.safeParse(raw)
		if (!parsed.success) {
			this.logger.warn('Skipping invalid session metadata', { sessionId, reason: parsed.error.message })
			return null
		}

		return parsed.data
	}

	protected async writeMetadata(sessionId: SessionId, metadata: SessionMetadata): Promise<void> {
		const path = this.getMetaPath(sessionId)
		await this.fs.mkdir(dirname(path), { recursive: true })
		await this.fs.writeFile(path, JSON.stringify(metadata, null, 2))

		// The cache may only hold what a read would return, so the record goes in through the same schema.
		const parsed = sessionMetadataSchema.safeParse(metadata)
		if (!parsed.success) {
			this.logger.warn('Not caching invalid session metadata', { sessionId, reason: parsed.error.message })
			this.metadataCache.delete(sessionId)
			return
		}

		// Cached only once the write lands, so a failed write leaves no phantom value.
		this.metadataCache.set(sessionId, { kind: 'record', record: parsed.data })
		this.reportedReadFailures.delete(sessionId)
	}

	protected async getAllSessionMetadata(): Promise<SessionMetadata[]> {
		const sessionsDir = join(this.basePath, 'sessions')

		let entries: Dirent[]
		try {
			entries = await this.fs.readdir(sessionsDir, { withFileTypes: true })
		} catch (error) {
			if (isNotFound(error)) {
				// The data root is gone, so every session cached from it is gone with it.
				this.forgetAll()
				return []
			}
			throw error
		}

		const sessions: SessionMetadata[] = []
		const present = new Set<SessionId>()

		for (const entry of entries) {
			if (!entry.isDirectory()) continue

			const sessionId = SessionId(entry.name)
			present.add(sessionId)

			const metadata = await this.readMetadataOrSkip(sessionId)
			if (metadata) sessions.push(metadata)
		}

		// The directory listing is the only thing that can remove a session, so prune here.
		this.forgetMissing(present)

		return sessions
	}

	/** One unreadable session must not take the listing down for every other one. */
	private async readMetadataOrSkip(sessionId: SessionId): Promise<SessionMetadata | null> {
		try {
			return await this.readMetadata(sessionId)
		} catch {
			return null // already reported by readMetadata
		}
	}

	private forgetMissing(present: Set<SessionId>): void {
		for (const sessionId of this.metadataCache.keys()) {
			if (!present.has(sessionId)) this.metadataCache.delete(sessionId)
		}
		for (const sessionId of this.reportedReadFailures.keys()) {
			if (!present.has(sessionId)) this.reportedReadFailures.delete(sessionId)
		}
	}

	private forgetAll(): void {
		this.metadataCache.clear()
		this.reportedReadFailures.clear()
	}
}
