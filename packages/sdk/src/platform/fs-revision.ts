/**
 * Filesystem revision adapter.
 *
 * One number that moves whenever anything in the host's filesystem changes, so
 * a caller holding an answer derived from the tree can tell "nothing happened"
 * from "read it again" without doing the read. It is a gate, never a substitute:
 * it says whether the previous answer still stands, not what the new one is.
 *
 * Its own port rather than a method on {@link FileSystem}, which mirrors node:fs
 * and gains nothing from a question node:fs never asks; and rather than a field
 * on the git port, because the signal is about bytes on disk, not about git.
 */

/** One path the filesystem touched, as reported by {@link FsRevision.changedSince}. */
export interface FsChange {
	/** Absolute path, as the host's filesystem names it. */
	path: string
	/** The node is gone as of this revision. */
	deleted: boolean
}

export interface ChangedSinceOptions {
	/** Only report paths below this directory. */
	under?: string
	/**
	 * Stop scanning after this many rows. A host that hits the cap answers
	 * `undefined` rather than a truncated list — a partial answer would read as
	 * "nothing else changed", which is the one lie this port must not tell.
	 */
	limit?: number
}

export interface FsRevision {
	/**
	 * Current revision, or `undefined` when the host cannot tell — which callers
	 * read as "recompute", the same as a host with no port at all.
	 *
	 * The number is opaque and only comparable for equality: two reads that agree
	 * saw no mutation between them. It covers the whole filesystem the host
	 * exposes, not a subtree, so it moves for writes the caller does not care
	 * about — a gate on it recomputes more often than strictly needed, never less.
	 *
	 * Never rejects: a host that cannot answer says so with `undefined`.
	 */
	current(): Promise<number | undefined>

	/**
	 * Which paths moved after `since`, or `undefined` when the host cannot say.
	 *
	 * The counter alone turns a question about the whole tree into a question
	 * about one number; this turns the recomputation that follows into one about
	 * the edit. A caller holding an answer plus the revision it was read at asks
	 * for the delta and reconciles only that, instead of walking the tree again —
	 * on a real site repository the difference is four orders of magnitude.
	 *
	 * `undefined` means "no cheap answer": no such index, a schema this host does
	 * not recognise, or more rows than `limit`. Callers recompute in full, which
	 * is what they did before the port existed.
	 *
	 * Directories are not reported — a directory whose mtime moved because a file
	 * under it was rewritten is not itself a change anyone asked about. Deletions
	 * are, since a path that is gone is a change no scan of live nodes can see.
	 *
	 * Never rejects.
	 */
	changedSince(since: number, options?: ChangedSinceOptions): Promise<FsChange[] | undefined>
}
