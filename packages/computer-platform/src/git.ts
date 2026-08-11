/**
 * GitClient over a `@cloudflare/computer` workspace.
 *
 * `workspace.git` drives isomorphic-git straight off the SQLite VFS, so an
 * isolate answers git questions with no process table and no `git` binary. The
 * workspace only has one once `createGitClient()` is passed as
 * `WorkspaceOptions.git`; without it the `git` getter throws.
 */

import type { CommitView, GitClient as ComputerGitClient } from '@cloudflare/computer/git'
import type { GitClient, GitCommit } from '@roj-ai/sdk/platform'
import type { NativeGitStatus } from './git-status/status.js'

export interface ComputerGitClientOptions {
	/**
	 * Answers `status` from the workspace's SQLite where it can, and `undefined`
	 * where it cannot. Without it every status is the binding's tree walk, which
	 * on a real site repository is ~9.7 s — see git-status/status.ts.
	 */
	nativeStatus?: NativeGitStatus
}

export function createComputerGitClient(git: ComputerGitClient, clientOptions: ComputerGitClientOptions = {}): GitClient {
	const { nativeStatus } = clientOptions
	return {
		// StatusEntry is already the port's XY shape — same codes, same meaning.
		async status(options) {
			const native = await nativeStatus?.(options.dir)
			return native ?? await git.status({ dir: options.dir })
		},

		async log(options) {
			const commits = await git.log({ dir: options.dir, ref: options.ref, depth: options.depth })
			return commits.map(toCommit)
		},

		/** No rev-list here, so count the HEAD walk's oids that the base walk never reaches. */
		async countAhead(options) {
			const [head, base] = await Promise.all([
				git.log({ dir: options.dir, ref: options.ref ?? 'HEAD' }),
				git.log({ dir: options.dir, ref: options.base }),
			])
			const reachable = new Set(base.map((commit) => commit.oid))
			return head.reduce((count, commit) => reachable.has(commit.oid) ? count : count + 1, 0)
		},

		// computer's git cannot read a remote's HEAD — its `symbolic-ref` accepts only
		// HEAD — so the base branch is never knowable and the caller keeps its default.
		defaultBranch: () => Promise.resolve(undefined),
	}
}

/** computer reports commit time in seconds; the port is in ms. */
function toCommit(commit: CommitView): GitCommit {
	return { oid: commit.oid, message: commit.message, committedAt: commit.committer.timestamp * 1000 }
}
