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
}
