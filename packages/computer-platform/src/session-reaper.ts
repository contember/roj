/**
 * Reclaims what a closed session leaves behind.
 *
 * A Durable Object degrades by lifetime, not by load. `session.close()` stops the
 * agents and seals the log, but the session's workspace directory, its
 * `sessions/<id>` data directory and its event rows all stay — so an object that
 * has churned a few thousand sessions carries every one of them forever.
 *
 * Nothing here hangs off a session hook. `Session.close()` and `Session.shutdown()`
 * both funnel into the same `onSessionClose` hooks, so a plugin cannot tell a
 * session ending from the isolate merely going away — and an eviction must not
 * delete anything. Reaping is therefore a host operation with its own retention
 * policy: the host knows whether it is shutting down or reclaiming, the SDK does not.
 *
 * The workspace is not ours to reach into. Its blobs are content-addressed and
 * shared between identical files with no refcount, so deletion goes through the
 * filesystem adapter's recursive remove and never through SQL.
 */

import type { DomainEvent, LoadRangeOptions, LoadRangeResult, SessionId, SessionMetadata } from '@roj-ai/sdk'

/** Sessions examined per sweep unless the caller says otherwise. */
const DEFAULT_LIMIT = 100

/**
 * Stamp left in `SessionMetadata.custom` when the files went but the rows stayed.
 *
 * Without it a files-only sweep is not idempotent: the rows still say "closed",
 * so every later sweep walks the same session again and re-removes a directory
 * that is already gone. Measured at 10 200 removals across 50 sweeps of 400
 * sessions before this existed.
 */
const REAPED_AT_KEY = 'reapedAt'

function isAlreadyReaped(metadata: SessionMetadata): boolean {
	return typeof metadata.custom?.[REAPED_AT_KEY] === 'number'
}

/**
 * The store surface a reap needs.
 *
 * `SqliteEventStore` satisfies it; `deleteSession` is the part no plain
 * `EventStore` has, which is what keeps an event log undeletable by default.
 */
export interface ReapableEventStore {
	listSessionsWithMetadata(
		options?: { status?: 'closed'; orderBy?: 'lastActivityAt'; order?: 'asc' },
	): Promise<{ sessions: SessionMetadata[]; total: number }>
	getMetadata(sessionId: SessionId): Promise<SessionMetadata | null>
	updateMetadata(sessionId: SessionId, update: Partial<SessionMetadata>): Promise<void>
	loadRange(sessionId: SessionId, options?: LoadRangeOptions): Promise<LoadRangeResult>
	deleteSession(sessionId: SessionId): Promise<number>
}

/** The one filesystem call a reap makes. `Platform['fs']` satisfies it. */
export interface ReapableFileSystem {
	rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>
}

/** The one session-log call a reap makes. `Platform['sessionLog']` satisfies it. */
export interface ReapableSessionLog {
	delete(sessionId: SessionId): Promise<number>
}

/** The one LLM-call-log call a reap makes. `Platform['llmCallLog']` satisfies it. */
export interface ReapableLLMCallLog {
	delete(sessionId: SessionId): Promise<number>
}

export interface SessionReaperOptions {
	eventStore: ReapableEventStore
	fs: ReapableFileSystem
	/**
	 * `basePath` the SessionManager was built with. Its `sessions/<id>` subtree —
	 * the session log and any per-session files — is reaped with the workspace.
	 * Omit it and only the workspace goes.
	 */
	dataDir?: string
	/**
	 * Where the host keeps `session.log` in rows instead of under `dataDir`.
	 * Reaped on the files branch, because that is where those bytes used to live —
	 * without it, moving the log into a table would just move the leak.
	 */
	sessionLog?: ReapableSessionLog
	/**
	 * Where the host keeps the LLM call log in rows instead of under `dataDir`.
	 * Same branch and same reason as `sessionLog`: `sessions/<id>/calls` is a
	 * files-side directory wherever it is not a table.
	 */
	llmCallLog?: ReapableLLMCallLog
	/**
	 * Sessions the host is still using. A closed session is not in SessionManager's
	 * cache, so this is for the case the store cannot see: a host holding a closed
	 * session it means to `reopen()`.
	 */
	isProtected?: (sessionId: SessionId) => boolean
}

export interface ReapOptions {
	/** Leave sessions closed more recently than this alone. Default 0 — every closed session. */
	minAgeMs?: number
	/** Sessions reaped per sweep, so one call cannot hold the isolate. Default 100. */
	limit?: number
	/** Drop the event log and metadata too. Off by default: the log is the only record. */
	events?: boolean
	/** Report what would go without removing anything. */
	dryRun?: boolean
}

export interface ReapedSession {
	sessionId: SessionId
	/** Directory removed, or null when the session never had one of its own. */
	workspaceDir: string | null
	removedWorkspace: boolean
	removedDataDir: boolean
	/** Log entries dropped from the session-log store. Always 0 on a host that has none. */
	removedLogLines: number
	/** Calls dropped from the LLM-call-log store. Always 0 on a host that has none. */
	removedLlmCalls: number
	removedEvents: number
	error?: string
}

/** Closed sessions left alone, by the guard that fired. */
export interface ReapSkipped {
	protectedByHost: number
	tooYoung: number
	reopened: number
	sharedWorkspace: number
	/** Files already gone and the log kept on purpose — nothing left for this sweep to do. */
	alreadyReaped: number
	overLimit: number
}

export interface ReapReport {
	/** Closed sessions the store reported — the backlog this sweep drew from. */
	closed: number
	reaped: ReapedSession[]
	skipped: ReapSkipped
	dryRun: boolean
	ms: number
}

export interface SessionReaper {
	reap(options?: ReapOptions): Promise<ReapReport>
}

/** What a session's `session_created` event says its workspace is. */
type WorkspaceTarget =
	| { kind: 'none' }
	| { kind: 'own'; dir: string }
	| { kind: 'shared'; dir: string }

/**
 * `DomainEvent` is `BaseEvent<string>`, not a union, so a payload field can only
 * be reached by proving it is there.
 */
function workspaceDirOf(event: DomainEvent | undefined): string | null {
	if (event === undefined || event.type !== 'session_created') return null
	if (!('workspaceDir' in event)) return null
	return typeof event.workspaceDir === 'string' ? event.workspaceDir : null
}

/**
 * Directory the session named for itself, classified.
 *
 * A dir whose last segment is the session id came from the `{sessionId}`
 * interpolation and belongs to this session alone. A preset with a fixed
 * `workspaceDir` shares one directory with every session that ever used it, and
 * removing it would take their files too — so that case is reported, not reaped.
 */
async function workspaceTarget(store: ReapableEventStore, sessionId: SessionId): Promise<WorkspaceTarget> {
	const head = await store.loadRange(sessionId, { limit: 1 })
	const dir = workspaceDirOf(head.events[0])
	if (dir === null) return { kind: 'none' }
	return dir.endsWith(`/${sessionId}`) ? { kind: 'own', dir } : { kind: 'shared', dir }
}

/** The listing is a snapshot and every removal awaits, so the status is re-read at each step. */
async function stillClosed(store: ReapableEventStore, sessionId: SessionId): Promise<boolean> {
	const metadata = await store.getMetadata(sessionId)
	return metadata?.status === 'closed'
}

function describe(error: unknown): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

export function createSessionReaper(options: SessionReaperOptions): SessionReaper {
	const { eventStore, fs, dataDir, sessionLog, llmCallLog, isProtected } = options

	return {
		async reap(reapOptions: ReapOptions = {}): Promise<ReapReport> {
			const startedAt = Date.now()
			const minAgeMs = reapOptions.minAgeMs ?? 0
			const limit = reapOptions.limit ?? DEFAULT_LIMIT
			const dryRun = reapOptions.dryRun === true
			const dropEvents = reapOptions.events === true
			const skipped: ReapSkipped = {
				protectedByHost: 0,
				tooYoung: 0,
				reopened: 0,
				sharedWorkspace: 0,
				alreadyReaped: 0,
				overLimit: 0,
			}
			const reaped: ReapedSession[] = []

			// Closed status is the guard: it is the store's own durable record that
			// nothing is running, and a live session is by definition not closed.
			const listed = await eventStore.listSessionsWithMetadata({
				// Oldest first, so a capped sweep eats the backlog instead of re-reading its tail.
				status: 'closed',
				orderBy: 'lastActivityAt',
				order: 'asc',
			})

			for (const metadata of listed.sessions) {
				const sessionId = metadata.sessionId
				if (reaped.length >= limit) {
					skipped.overLimit++
					continue
				}
				if (isProtected?.(sessionId) === true) {
					skipped.protectedByHost++
					continue
				}
				if (!dropEvents && isAlreadyReaped(metadata)) {
					skipped.alreadyReaped++
					continue
				}
				if (startedAt - metadata.lastActivityAt < minAgeMs) {
					skipped.tooYoung++
					continue
				}
				if (!await stillClosed(eventStore, sessionId)) {
					skipped.reopened++
					continue
				}

				const target = await workspaceTarget(eventStore, sessionId)
				if (target.kind === 'shared') {
					skipped.sharedWorkspace++
					continue
				}

				const entry: ReapedSession = {
					sessionId,
					workspaceDir: target.kind === 'own' ? target.dir : null,
					removedWorkspace: false,
					removedDataDir: false,
					removedLogLines: 0,
					removedLlmCalls: 0,
					removedEvents: 0,
				}
				if (dryRun) {
					reaped.push(entry)
					continue
				}

				try {
					// Workspace before rows: the rows are how the workspace is found again,
					// so the reverse order would orphan a directory nothing names.
					if (target.kind === 'own' && !isAlreadyReaped(metadata)) {
						await fs.rm(target.dir, { recursive: true, force: true })
						entry.removedWorkspace = true
					}
					if (dataDir !== undefined && !isAlreadyReaped(metadata)) {
						await fs.rm(`${dataDir}/sessions/${sessionId}`, { recursive: true, force: true })
						entry.removedDataDir = true
					}
					// The log is a data-dir file wherever it is not a table, so it goes here
					// and not with the event rows — `events: false` must still reclaim it.
					if (sessionLog !== undefined && !isAlreadyReaped(metadata)) {
						entry.removedLogLines = await sessionLog.delete(sessionId)
					}
					// Same branch for the same reason: `sessions/<id>/calls` is files elsewhere.
					if (llmCallLog !== undefined && !isAlreadyReaped(metadata)) {
						entry.removedLlmCalls = await llmCallLog.delete(sessionId)
					}
					if (dropEvents) {
						if (await stillClosed(eventStore, sessionId)) {
							entry.removedEvents = await eventStore.deleteSession(sessionId)
						} else {
							entry.error = 'reopened while its files were being removed'
							skipped.reopened++
						}
					} else {
						// The rows outlive the files, so they carry the record that the files went.
						// lastActivityAt is restated because updateMetadata otherwise stamps now,
						// which would restart the minAgeMs clock on a session that just aged out.
						await eventStore.updateMetadata(sessionId, {
							lastActivityAt: metadata.lastActivityAt,
							custom: { ...metadata.custom, [REAPED_AT_KEY]: Date.now() },
						})
					}
				} catch (error) {
					entry.error = describe(error)
				}
				reaped.push(entry)
			}

			return { closed: listed.total, reaped, skipped, dryRun, ms: Date.now() - startedAt }
		},
	}
}
