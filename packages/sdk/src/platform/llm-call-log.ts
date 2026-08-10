/**
 * LLM call-log store adapter.
 *
 * `LLMLogger` keeps the complete request and response of every inference — the
 * audit record the debug UI's LLM Calls page and `@roj-ai/cli` read. As files it
 * is one pretty-printed JSON blob per call, written twice: once by `createCall`
 * and once by `completeCall`, which reads the whole entry back first. At the
 * measured ~17 KB per call and 4 inferences per turn that is 8 `writeFile` plus
 * 4 `readFile` and ~70 KB a turn, and `listCalls` is a `readdir` plus one
 * `readFile` per row of the page (see `packages/computer-worker/README.md`,
 * `/limits/fs-traffic`).
 *
 * On a host whose filesystem is itself SQLite none of that is worth paying, so
 * this port exists to spend rows instead. Optional, like `SessionLogStore`:
 * a host without a table keeps the files, the paths and the bytes it always had.
 *
 * The row is split rather than held as one entry blob for one reason:
 * `completeCall` must not be a read-modify-write. Response, metrics and error
 * are their own columns, so completing a call is a bounded `UPDATE` that never
 * re-reads or re-writes the request it belongs to.
 */

/** The three states a logged call can be in, matching `LLMCallLogEntry.status`. */
export type LLMCallStatus = 'running' | 'success' | 'error'

/**
 * One logged call, as columns.
 *
 * Scalars are what a listing filters, orders and pages on; the rest is JSON the
 * store carries without reading. `sessionId` is not here — it is the key every
 * method takes, exactly as in `SessionLogStore`.
 */
export interface LLMCallRow {
	/** UUIDv7. Sortable, so it is both the identity and the order — see `list`. */
	callId: string
	agentId: string
	createdAt: number
	status: LLMCallStatus
	/**
	 * Copied out of {@link request} so a listing can filter and show it without
	 * parsing the blob. A model id is tens of bytes against the blob's ~17 KB.
	 */
	model: string
	/**
	 * Serialized `LLMCallRequest`. Written once by {@link create} and never
	 * rewritten. The only column that grows with the session, because the message
	 * history is in it — see {@link LLMCallStore.maxBlobBytes}.
	 */
	request: string
	completedAt?: number
	durationMs?: number
	providerRequestId?: string
	/** Serialized `LLMCallResponse`. Absent while the call is still running. */
	response?: string
	/** Serialized `LLMCallMetrics`. Absent until the call succeeds. */
	metrics?: string
	/** Serialized `LLMCallError`. Absent unless the call failed. */
	error?: string
}

/** Everything a finished call adds to its row. The request is never part of it. */
export interface LLMCallOutcome {
	status: 'success' | 'error'
	completedAt: number
	durationMs: number
	providerRequestId?: string
	response?: string
	metrics?: string
	error?: string
}

export interface LLMCallPage {
	calls: LLMCallRow[]
	/** Calls the session holds, before `limit`/`offset` — what the UI shows as the count. */
	total: number
}

export interface LLMCallStore {
	/**
	 * Largest value one column can hold, where the host has a ceiling.
	 *
	 * A Durable Object's is 2 199 994 B, measured. A call is ~17 KB, but the
	 * message history inside `request` grows with the session and a single tool
	 * result may be megabytes — so the caller clamps `request` to this before
	 * handing it over, rather than letting an oversized prompt turn a logged call
	 * into a failed inference. Absent means no ceiling and no clamping.
	 */
	readonly maxBlobBytes?: number

	/** Record a call that has just started. */
	create(sessionId: string, row: LLMCallRow): Promise<void>

	/**
	 * Attach the outcome to a call already recorded.
	 *
	 * A call id the store does not hold is not an error: the file path skips the
	 * update when its entry has gone, and a reap between the two halves of one
	 * inference is exactly that case.
	 */
	complete(sessionId: string, callId: string, outcome: LLMCallOutcome): Promise<void>

	get(sessionId: string, callId: string): Promise<LLMCallRow | null>

	/**
	 * One page of a session's calls, newest first.
	 *
	 * Ordered by `callId` descending, which is what the file path's sorted
	 * `readdir` produced: UUIDv7 is time-ordered, fixed width and lowercase hex,
	 * so its lexicographic order is its chronological one — and unlike a
	 * timestamp it is total, so two calls in the same millisecond still page
	 * without overlapping or skipping.
	 */
	list(sessionId: string, options: { limit: number; offset: number }): Promise<LLMCallPage>

	/**
	 * Drop every call held for one session, and report how many went.
	 *
	 * The calls live under the session's data directory on a file host, so they
	 * are reclaimed with the *files*, not with the event log — see `createSessionReaper`.
	 */
	delete(sessionId: string): Promise<number>
}
