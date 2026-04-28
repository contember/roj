import type { DomainEvent } from '~/core/events/types.js'
import type { ListSessionsOptions, SessionId, SessionMetadata } from '~/core/sessions/schema.js'
import { EventStoreError, type EventStore, type LoadRangeOptions, type LoadRangeResult } from './event-store.js'
import type { MetadataEvent } from './metadata-utils.js'
import { computeMetadataFromEvents, needsReconciliation } from './metadata-utils.js'

/**
 * Event types that must never be emitted on a closed session.
 * See guardWriteToClosed for rationale.
 */
function isForbiddenOnClosed(event: DomainEvent): boolean {
	return event.type === 'session_handler_started' || event.type === 'session_handler_completed'
}

/**
 * Abstract base class for EventStore implementations.
 *
 * Provides shared logic for metadata processing, filtering/sorting/pagination,
 * and reconciliation. Subclasses only implement storage primitives.
 */
export abstract class BaseEventStore implements EventStore {
	// === Public append API (with closed-session guard) ===

	async append(sessionId: SessionId, event: DomainEvent): Promise<void> {
		if (isForbiddenOnClosed(event)) {
			await this.guardWriteToClosed(sessionId, [event])
		}
		await this.doAppend(sessionId, event)
	}

	async appendBatch(sessionId: SessionId, events: DomainEvent[]): Promise<void> {
		if (events.length === 0) return
		if (events.some(isForbiddenOnClosed)) {
			await this.guardWriteToClosed(sessionId, events)
		}
		await this.doAppendBatch(sessionId, events)
	}

	// === Storage primitives (subclasses implement) ===

	protected abstract doAppend(sessionId: SessionId, event: DomainEvent): Promise<void>
	protected abstract doAppendBatch(sessionId: SessionId, events: DomainEvent[]): Promise<void>
	abstract load(sessionId: SessionId): Promise<DomainEvent[]>
	abstract loadRange(sessionId: SessionId, options?: LoadRangeOptions): Promise<LoadRangeResult>
	abstract exists(sessionId: SessionId): Promise<boolean>
	abstract listSessions(): Promise<SessionId[]>

	// === Metadata storage primitives (subclasses implement) ===

	protected abstract readMetadata(sessionId: SessionId): Promise<SessionMetadata | null>
	protected abstract writeMetadata(sessionId: SessionId, metadata: SessionMetadata): Promise<void>
	protected abstract getAllSessionMetadata(): Promise<SessionMetadata[]>

	// === Shared implementations ===

	async getMetadata(sessionId: SessionId): Promise<SessionMetadata | null> {
		return this.readMetadata(sessionId)
	}

	async updateMetadata(
		sessionId: SessionId,
		update: Partial<SessionMetadata>,
	): Promise<void> {
		const existing = await this.readMetadata(sessionId)
		const metadata: SessionMetadata = {
			...existing,
			...update,
			sessionId,
			lastActivityAt: update.lastActivityAt ?? Date.now(),
		} as SessionMetadata

		await this.writeMetadata(sessionId, metadata)
	}

	async listSessionsWithMetadata(
		options?: ListSessionsOptions,
	): Promise<{ sessions: SessionMetadata[]; total: number }> {
		let sessions = await this.getAllSessionMetadata()

		// Filter by status
		if (options?.status) {
			sessions = sessions.filter((s) => s.status === options.status)
		}

		// Filter by tags
		if (options?.tags && options.tags.length > 0) {
			sessions = sessions.filter((s) => options.tags!.every((tag) => s.tags?.includes(tag)))
		}

		const total = sessions.length

		// Sort
		const orderBy = options?.orderBy ?? 'createdAt'
		const order = options?.order ?? 'desc'
		sessions.sort((a, b) => {
			const aVal = a[orderBy] ?? 0
			const bVal = b[orderBy] ?? 0
			return order === 'asc' ? aVal - bVal : bVal - aVal
		})

		// Pagination
		const offset = options?.offset ?? 0
		const limit = options?.limit ?? sessions.length
		sessions = sessions.slice(offset, offset + limit)

		return { sessions, total }
	}

	async reconcileMetadata(
		sessionId: SessionId,
		events: DomainEvent[],
	): Promise<boolean> {
		if (events.length === 0) return false

		const computed = computeMetadataFromEvents(sessionId, events)
		if (!computed) return false

		const stored = await this.readMetadata(sessionId)

		if (!needsReconciliation(stored, computed)) {
			return false
		}

		// Metadata is out of sync - update with computed values
		// Preserve name, tags, and custom data from stored metadata
		const reconciled: SessionMetadata = {
			...computed,
			name: stored?.name,
			tags: stored?.tags,
			custom: stored?.custom,
		}

		await this.writeMetadata(sessionId, reconciled)
		return true
	}

	/**
	 * Update metadata incrementally from events.
	 * Aggregates all metric deltas and writes once.
	 */
	protected async updateMetadataFromEvents(
		sessionId: SessionId,
		events: DomainEvent[],
	): Promise<void> {
		if (events.length === 0) return

		const metadata = await this.readMetadata(sessionId)

		// Start with current metrics or defaults
		let metrics = metadata?.metrics ?? {
			totalEvents: 0,
			totalAgents: 0,
			totalTokens: 0,
			totalLLMCalls: 0,
			inputTokens: 0,
			outputTokens: 0,
			totalCost: 0,
			totalMessages: 0,
			totalToolCalls: 0,
		}

		const update: Partial<SessionMetadata> = {}

		// Process all events and aggregate metrics
		for (const event of events as MetadataEvent[]) {
			update.lastActivityAt = event.timestamp

			switch (event.type) {
				case 'session_created':
					update.createdAt = event.timestamp
					update.presetId = event.presetId
					update.status = 'active'
					metrics = {
						totalEvents: 1,
						totalAgents: 0,
						totalTokens: 0,
						totalLLMCalls: 0,
						inputTokens: 0,
						outputTokens: 0,
						totalCost: 0,
						totalMessages: 0,
						totalToolCalls: 0,
					}
					break

				case 'session_closed':
					update.status = 'closed'
					metrics.totalEvents += 1
					break

				case 'session_reopened':
					update.status = 'active'
					metrics.totalEvents += 1
					break

				case 'agent_spawned':
					metrics.totalAgents += 1
					metrics.totalEvents += 1
					break

				case 'inference_completed':
					if (event.metrics) {
						metrics.totalTokens += event.metrics.totalTokens ?? 0
						metrics.inputTokens = (metrics.inputTokens ?? 0) + (event.metrics.promptTokens ?? 0)
						metrics.outputTokens = (metrics.outputTokens ?? 0) + (event.metrics.completionTokens ?? 0)
						metrics.totalCost = (metrics.totalCost ?? 0) + (event.metrics.cost ?? 0)
						metrics.totalLLMCalls += 1
					}
					metrics.totalEvents += 1
					break

				case 'mailbox_message':
					metrics.totalMessages = (metrics.totalMessages ?? 0) + 1
					metrics.totalEvents += 1
					break

				case 'tool_started':
					metrics.totalToolCalls = (metrics.totalToolCalls ?? 0) + 1
					metrics.totalEvents += 1
					break

				default:
					metrics.totalEvents += 1
			}
		}

		update.metrics = metrics
		await this.updateMetadata(sessionId, update)
	}

	/**
	 * Reject session-level hook events on closed sessions.
	 *
	 * Closed sessions must be prevented from re-running session-level plugin hooks
	 * (the `session_handler_*` events) because those hooks have no place operating
	 * on an immutable artifact — and when they do, every read / restart of the closed
	 * session appends two events, which is how we observed 7866 handler_started events
	 * on a single closed session over 4.9 days in production.
	 *
	 * Other event types are deliberately allowed even after session_closed:
	 *   - in-flight agent events (inference_*, tool_*) finishing after close
	 *   - mailbox_message deliveries racing close
	 *   - service_status_changed from cleanup hooks stopping services
	 *
	 * The invariant we guard is narrow: "session-level plugin hooks never emit on
	 * closed sessions." See the loadSession / skipReadyHooks path in session-manager
	 * for the primary fix; this is the storage-boundary backup that catches any
	 * future code path that somehow slips through.
	 */
	protected async guardWriteToClosed(sessionId: SessionId, events: DomainEvent[]): Promise<void> {
		const forbidden = events.filter(isForbiddenOnClosed)
		if (forbidden.length === 0) return

		const metadata = await this.readMetadata(sessionId)
		if (metadata?.status !== 'closed') return

		const forbiddenTypes = forbidden.map((e) => e.type).join(', ')
		throw new EventStoreError(
			`Refusing to append session-level hook event(s) to closed session ${sessionId} (types: ${forbiddenTypes}). `
				+ `Closed sessions must not re-run plugin session hooks — see session-manager.ts:loadSession closed branch.`,
			sessionId,
		)
	}
}
