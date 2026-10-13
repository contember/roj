import { posix } from 'node:path'
import type { Filesystem, MountSpec } from '@kompjutr/do/fs'
import type { ShellGrant } from '@roj-ai/sdk/platform'

/** A real workspace path, and the mount that shows it. */
export interface MountedPath {
	mount: MountSpec
	real: string
}

/**
 * One run's grants as mounts, plus the prefix translation between the paths a
 * command sees and the workspace's real ones, for consumers that bypass the view.
 */
export class GrantMounts {
	readonly specs: readonly MountSpec[]

	constructor(filesystem: Filesystem, grants: readonly ShellGrant[]) {
		this.specs = grants.map((grant) => ({
			path: posix.resolve(grant.path),
			// A bind mount follows symlinks in its source; the view accepts only the resolved directory.
			source: filesystem.realpath(posix.resolve(grant.source ?? grant.path)),
			mode: grant.mode,
		}))
	}

	/** The real path behind a canonical virtual path, or undefined outside every mount. */
	toReal(virtualPath: string): MountedPath | undefined {
		for (const mount of this.specs) {
			const rest = suffixUnder(mount.path, virtualPath)
			if (rest !== undefined) return { mount, real: joinSuffix(mount.source, rest) }
		}
		return undefined
	}

	/** A virtual path showing `realPath`, from `preferred` when it shows it, otherwise from the narrowest source. */
	toVirtual(realPath: string, preferred?: MountSpec): string | undefined {
		const candidates = [...this.specs].sort((left, right) => right.source.length - left.source.length)
		if (preferred !== undefined) candidates.unshift(preferred)
		for (const mount of candidates) {
			const rest = suffixUnder(mount.source, realPath)
			if (rest !== undefined) return joinSuffix(mount.path, rest)
		}
		return undefined
	}

	/** Whether a writable mount shows `realPath`. */
	isWritable(realPath: string): boolean {
		return this.specs.some((mount) => mount.mode === 'rw' && suffixUnder(mount.source, realPath) !== undefined)
	}
}

/** `''` when `path` is `root`, `/rest` when below it, undefined otherwise. */
function suffixUnder(root: string, path: string): string | undefined {
	if (path === root) return ''
	if (root === '/') return path.startsWith('/') ? path : undefined
	return path.startsWith(`${root}/`) ? path.slice(root.length) : undefined
}

function joinSuffix(root: string, suffix: string): string {
	if (suffix === '') return root
	return root === '/' ? suffix : `${root}${suffix}`
}
