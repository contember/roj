import { dirname, join } from 'node:path'
import z from 'zod/v4'
import type { DomainEvent } from '~/core/events/types.js'
import type { FileSystem } from '~/platform/fs.js'
import { domainEventSchema, SessionId, sessionMetadataSchema } from '~/core/sessions/schema.js'
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

	constructor(private readonly basePath: string, private readonly fs: FileSystem) {
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
			return entries
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name as SessionId)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
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
		const path = this.getMetaPath(sessionId)

		try {
			const content = await this.fs.readFile(path, 'utf-8')
			const parsed = JSON.parse(content)
			const validated = sessionMetadataSchema.parse(parsed)
			return validated as SessionMetadata
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return null
			}
			throw error
		}
	}

	protected async writeMetadata(sessionId: SessionId, metadata: SessionMetadata): Promise<void> {
		const path = this.getMetaPath(sessionId)
		await this.fs.mkdir(dirname(path), { recursive: true })
		await this.fs.writeFile(path, JSON.stringify(metadata, null, 2))
	}

	protected async getAllSessionMetadata(): Promise<SessionMetadata[]> {
		const sessionsDir = join(this.basePath, 'sessions')

		try {
			const entries = await this.fs.readdir(sessionsDir, { withFileTypes: true })
			const sessions: SessionMetadata[] = []

			for (const entry of entries) {
				if (!entry.isDirectory()) continue

				const metadata = await this.readMetadata(entry.name as SessionId)
				if (metadata) sessions.push(metadata)
			}

			return sessions
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return []
			}
			throw error
		}
	}
}
