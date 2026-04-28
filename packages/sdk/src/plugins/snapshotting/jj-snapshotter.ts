import { join } from 'node:path'
import type { FileSystem } from '~/platform/fs.js'
import type { ProcessRunner } from '~/platform/process.js'
import type { Logger } from '../../lib/logger/logger.js'
import type { ForkSnapshotOptions, SnapshotRefs, Snapshotter } from './snapshotter.js'

const JJ_IGNORE_CONTENT = '.roj/\n.events/\n'

/**
 * Run a command and return stdout as string.
 * Returns undefined if the command fails.
 */
function runCommand(process: ProcessRunner, command: string, args: string[], cwd: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		const child = process.spawn(command, args, { cwd })
		let stdout = ''
		let stderr = ''
		child.stdout?.on('data', (data: Buffer) => {
			stdout += data.toString()
		})
		child.stderr?.on('data', (data: Buffer) => {
			stderr += data.toString()
		})
		child.on('error', () => resolve(undefined))
		child.on('close', (code) => {
			if (code === 0) {
				resolve(stdout.trim())
			} else {
				resolve(undefined)
			}
		})
	})
}

export interface JjSnapshotterDeps {
	fs: FileSystem
	process: ProcessRunner
}

/**
 * JJ (Jujutsu VCS) based snapshotter.
 *
 * Creates JJ repositories in session and workspace directories
 * and takes snapshots by reading the current commit ID.
 */
export class JjSnapshotter implements Snapshotter {
	private readonly fs: FileSystem
	private readonly process: ProcessRunner

	constructor(
		private readonly sessionDir: string,
		private readonly workspaceDir: string | undefined,
		private readonly logger: Logger,
		deps: JjSnapshotterDeps,
	) {
		this.fs = deps.fs
		this.process = deps.process
	}

	async init(): Promise<void> {
		// Session dir: always init + create .jjignore
		await this.fs.mkdir(this.sessionDir, { recursive: true })
		await runCommand(this.process, 'jj', ['git', 'init'], this.sessionDir)
		await this.fs.writeFile(join(this.sessionDir, '.jjignore'), JJ_IGNORE_CONTENT)
		this.logger.debug('JJ repo initialized for session dir', { dir: this.sessionDir })

		// Workspace dir: only init if .jj/ doesn't exist yet
		if (this.workspaceDir) {
			if (!(await this.fs.exists(join(this.workspaceDir, '.jj')))) {
				await this.fs.mkdir(this.workspaceDir, { recursive: true })
				await runCommand(this.process, 'jj', ['git', 'init'], this.workspaceDir)
				this.logger.debug('JJ repo initialized for workspace dir', { dir: this.workspaceDir })
			} else {
				this.logger.debug('JJ repo already exists for workspace dir', { dir: this.workspaceDir })
			}
		}
	}

	async initFromFork(options: ForkSnapshotOptions): Promise<void> {
		// Session dir: copy .jj/ from source, write .jjignore, restore working copy
		await this.fs.mkdir(this.sessionDir, { recursive: true })
		await this.fs.cp(join(options.sourceSessionDir, '.jj'), join(this.sessionDir, '.jj'), { recursive: true })
		await this.fs.writeFile(join(this.sessionDir, '.jjignore'), JJ_IGNORE_CONTENT)

		if (options.sessionRef) {
			await runCommand(this.process, 'jj', ['edit', options.sessionRef], this.sessionDir)
			this.logger.debug('JJ fork: session dir restored', { dir: this.sessionDir, ref: options.sessionRef })
		} else {
			this.logger.debug('JJ fork: session dir copied (no ref to restore)', { dir: this.sessionDir })
		}

		// Workspace dir: copy .jj/ from source workspace, restore working copy
		if (this.workspaceDir && options.sourceWorkspaceDir) {
			await this.fs.mkdir(this.workspaceDir, { recursive: true })
			await this.fs.cp(join(options.sourceWorkspaceDir, '.jj'), join(this.workspaceDir, '.jj'), { recursive: true })

			if (options.workspaceRef) {
				await runCommand(this.process, 'jj', ['edit', options.workspaceRef], this.workspaceDir)
				this.logger.debug('JJ fork: workspace dir restored', { dir: this.workspaceDir, ref: options.workspaceRef })
			} else {
				this.logger.debug('JJ fork: workspace dir copied (no ref to restore)', { dir: this.workspaceDir })
			}
		}
	}

	async snapshot(): Promise<SnapshotRefs> {
		const [sessionRef, workspaceRef] = await Promise.all([
			this.snapshotDir(this.sessionDir),
			this.workspaceDir ? this.snapshotDir(this.workspaceDir) : Promise.resolve(undefined),
		])

		return { sessionRef, workspaceRef }
	}

	private async snapshotDir(dir: string): Promise<string | undefined> {
		const result = await runCommand(this.process, 'jj', ['log', '-r', '@', '--no-graph', '-T', 'commit_id'], dir)
		if (!result) {
			this.logger.warn('JJ snapshot failed', { dir })
		}
		return result
	}
}
