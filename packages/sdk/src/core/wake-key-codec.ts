/**
 * Segment codec for scheduler wake keys.
 *
 * `:` separates a key's segments, and the segments are caller-supplied strings —
 * `createSession` accepts any `sessionId`, and plugin names come from user
 * config. An unescaped `:` in one would mint a key the parser silently drops,
 * and a dropped wake is an agent that never resumes with nothing in the log.
 *
 * So every dynamic segment round-trips through percent-encoding, which leaves
 * ordinary ids (uuidv7, `orchestrator_1`, `git-status`) byte-for-byte unchanged.
 */

/** Percent-encodes `:` along with everything else outside the unreserved set. */
export function encodeWakeSegment(segment: string): string {
	return encodeURIComponent(segment)
}

/** `undefined` for a malformed escape — parsers read that as "not our key". */
export function decodeWakeSegment(segment: string): string | undefined {
	try {
		return decodeURIComponent(segment)
	} catch {
		return undefined
	}
}
