/**
 * LLM call-log store adapter.
 *
 * `LLMLogger` keeps the complete request and response of every inference. As
 * files that is one JSON blob per call, written twice and read back in between.
 * On a host whose filesystem is itself SQLite, rows are cheaper.
 *
 * The row is split rather than held as one blob so `complete` is a bounded
 * `UPDATE` that never re-reads or re-writes the request it belongs to.
 */

/** The three states a logged call can be in. */
export type LLMCallStatus = 'running' | 'success' | 'error'

/**
 * One logged call, as columns. Scalars are what a listing filters, orders and
 * pages on; the rest is JSON the store carries without reading.
 */
export interface LLMCallRow {
	/** UUIDv7. Sortable, so it is both the identity and the order — see `list`. */
	callId: string
	agentId: string
	createdAt: number
	status: LLMCallStatus
	/** Copied out of `request` so a listing can show it without parsing the blob. */
	model: string
	/** Serialized `LLMCallRequest`. Written once and never rewritten. */
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
	 * Largest value one column can hold, where the host has a ceiling. The caller
	 * clamps `request` to it rather than letting an oversized prompt turn a logged
	 * call into a failed inference. Absent means no ceiling and no clamping.
	 */
	readonly maxBlobBytes?: number

	/** Record a call that has just started. */
	create(sessionId: string, row: LLMCallRow): Promise<void>

	/**
	 * Attach the outcome to a call already recorded. A call id the store does not
	 * hold is not an error — a reap between the two halves of one inference is
	 * exactly that case.
	 */
	complete(sessionId: string, callId: string, outcome: LLMCallOutcome): Promise<void>

	get(sessionId: string, callId: string): Promise<LLMCallRow | null>

	/**
	 * One page of a session's calls, newest first, ordered by `callId` descending.
	 * UUIDv7 is time-ordered and fixed width, so that order is chronological and
	 * total — two calls in the same millisecond still page without overlapping.
	 */
	list(sessionId: string, options: { limit: number; offset: number }): Promise<LLMCallPage>

	/** Drop every call held for one session, and report how many went. */
	delete(sessionId: string): Promise<number>
}
