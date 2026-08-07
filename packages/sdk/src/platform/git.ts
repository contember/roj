/**
 * Git adapter interface.
 *
 * The read-only slice of git the SDK asks a workspace about. Deliberately not a
 * git binding: it names the four questions `git-status` asks, so a host can
 * answer them however it can — a `git` process, or a library over a VFS.
 * Concrete implementations live in runtime packages (e.g. `@roj-ai/computer-platform`).
 */

/** Every operation is scoped to one working tree. */
export interface GitRepoOptions {
	/** Working-tree directory of the repository. */
	dir: string
}

/**
 * One non-clean path, following git's XY convention: `index` is the staged
 * delta against HEAD, `worktree` the unstaged delta against the staged version.
 */
export interface GitStatusEntry {
	path: string
	index: ' ' | 'A' | 'M' | 'D'
	worktree: ' ' | 'A' | 'M' | 'D' | '?'
}

export interface GitCommit {
	oid: string
	/** Full commit message, subject line first. */
	message: string
	/** Commit time in ms since epoch, like every other SDK timestamp. */
	committedAt: number
}

export interface GitLogOptions extends GitRepoOptions {
	/** Ref to walk back from. Defaults to HEAD. */
	ref?: string
	/** Max commits to return. Unbounded when omitted. */
	depth?: number
}

export interface GitCountAheadOptions extends GitRepoOptions {
	/** Ref the count is measured from. */
	base: string
	/** Ref being measured. Defaults to HEAD. */
	ref?: string
}

/**
 * Read-only git queries over a working tree.
 *
 * Every method rejects when `dir` is not inside a repository; callers read that
 * as "no git state to report", not as a host failure.
 */
export interface GitClient {
	/** Paths that are not clean — `git status --porcelain`. */
	status(options: GitRepoOptions): Promise<GitStatusEntry[]>

	/** Commits reachable from `ref`, newest first — `git log`. */
	log(options: GitLogOptions): Promise<GitCommit[]>

	/** Commits in `ref` but not in `base` — `git rev-list --count <base>..<ref>`. */
	countAhead(options: GitCountAheadOptions): Promise<number>

	/**
	 * Branch new commits are measured against — the remote's HEAD, where the host
	 * can read one. `undefined` means unknown, so the caller applies its own default.
	 */
	defaultBranch(options: GitRepoOptions): Promise<string | undefined>
}
