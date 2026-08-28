/**
 * Filesystem revision adapter.
 *
 * One number that moves whenever anything in the host's filesystem changes, so a
 * caller holding an answer derived from the tree can tell "nothing happened" from
 * "read it again" without doing the read. A gate, never a source.
 */

export interface FsRevision {
	/**
	 * Current revision, or `undefined` when the host cannot tell — which callers
	 * read as "recompute", the same as a host with no port at all.
	 *
	 * The number is opaque and only comparable for equality. It covers the whole
	 * filesystem the host exposes, so it moves for writes the caller does not care
	 * about: a gate on it recomputes more often than needed, never less.
	 *
	 * Never rejects: a host that cannot answer says so with `undefined`.
	 */
	current(): Promise<number | undefined>
}
