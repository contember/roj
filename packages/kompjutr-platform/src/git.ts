/**
 * `GitClient` port over kompjutr's git runtime.
 *
 * The port names four questions `git-status` asks, and kompjutr answers each
 * one directly rather than by walking a tree: status reads its index tracker,
 * and `divergence` counts both sides of a fork in one call. Two of the four had
 * no honest answer over the binding this replaces.
 */

import type { GitClient, GitCommit, GitCountAheadOptions, GitLogOptions, GitRepoOptions, GitStatusEntry } from '@roj-ai/sdk/platform'
import type { Git, StatusEntry } from 'kompjutr'

/**
 * kompjutr's ordinary codes are already the port's alphabet. Three are not:
 * a rename is an add at the new path, an unmerged path is a modification, and
 * an ignored one is not a change anybody asked about.
 */
function toStatusEntry(entry: StatusEntry): GitStatusEntry | undefined {
	if (entry.index === '!' || entry.worktree === '!') return undefined
	const index = entry.index === 'R' ? 'A' : entry.index === 'U' ? 'M' : entry.index
	const worktree = entry.worktree === 'U' ? 'M' : entry.worktree
	return { path: entry.path, index, worktree }
}

export function createKompjutrGitClient(git: Git): GitClient {
	return {
		async status(options: GitRepoOptions): Promise<GitStatusEntry[]> {
			const entries = await git.status({ dir: options.dir })
			return entries.map(toStatusEntry).filter((entry): entry is GitStatusEntry => entry !== undefined)
		},

		async log(options: GitLogOptions): Promise<GitCommit[]> {
			const commits = await git.log({ dir: options.dir, ref: options.ref, depth: options.depth })
			return commits.map((commit) => ({
				oid: commit.oid,
				message: commit.message,
				// Git counts seconds; every SDK timestamp is milliseconds.
				committedAt: commit.committer.timestamp * 1000,
			}))
		},

		async countAhead(options: GitCountAheadOptions): Promise<number> {
			const result = await git.divergence({ dir: options.dir, current: options.ref ?? 'HEAD', upstream: options.base })
			return result.ahead
		},

		async defaultBranch(options: GitRepoOptions): Promise<string | undefined> {
			try {
				const ref = await git.readRef({ dir: options.dir, ref: 'refs/remotes/origin/HEAD' })
				if (ref.kind !== 'symbolic') return undefined
				return ref.target.split('/').pop() || undefined
			} catch {
				// "undefined means unknown, so the caller applies its own default."
				return undefined
			}
		},
	}
}
