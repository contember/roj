import { join, posix, resolve } from 'node:path'
import z from 'zod/v4'
import { definePlugin } from '~/core/plugins/plugin-builder.js'
import { type ArchiveLimitOverrides, inspectZipArchive } from '~/lib/archive/index.js'
import { Ok } from '~/lib/utils/result.js'
import type { FileSystem } from '~/platform/fs.js'
import type { ProcessRunner } from '~/platform/process.js'
import { ResourceBasenameSchema } from './filename.js'
import { RESOURCE_MANIFEST_FILENAME, type ResourceManifest, ResourceManifestSchema } from './manifest.js'
import {
	type PostInjectContext,
	type PostInjectExecOptions,
	type PostInjectHook,
	postInjectRules,
} from './post-inject.js'
import { type InjectedResource, type ResourcesState, resourceEvents } from './state.js'

const ARCHIVE_TIMEOUT_MS = 120_000
const ARCHIVE_MAX_BUFFER = 50 * 1024 * 1024

export interface ResourcesTargetDirArgs {
	sessionId: string
	sessionDir: string
	workspaceDir?: string
}

export type ResourcesTargetDir = string | ((args: ResourcesTargetDirArgs) => string | Promise<string>)

export interface ResourcesPluginConfig {
	targetDir?: ResourcesTargetDir
	/** Entry and expanded-size limits for each injected ZIP resource. */
	archiveLimits?: ArchiveLimitOverrides
	/**
	 * Called after a resource is written/extracted into `targetDir`, before the
	 * `resource_injected` event is emitted. Use `postInjectRules` for a declarative
	 * setup, or pass a custom async function for full control.
	 */
	postInject?: PostInjectHook
}

function makeExec(processRunner: ProcessRunner) {
	return async function exec(
		cmd: string,
		args: string[],
		options?: PostInjectExecOptions,
	): Promise<{ stdout: string; stderr: string }> {
		return processRunner.execFile(cmd, args, {
			timeout: options?.timeout ?? ARCHIVE_TIMEOUT_MS,
			maxBuffer: ARCHIVE_MAX_BUFFER,
			cwd: options?.cwd,
			env: options?.env ? { ...process.env, ...options.env } : undefined,
		})
	}
}

function normalizeArchiveEntryPath(path: string): string {
	return posix.normalize(path)
}

function isExcludedGitPath(path: string): boolean {
	const normalized = normalizeArchiveEntryPath(path)
	return normalized === '.git' || normalized.startsWith('.git/')
}

function getErrorCode(error: unknown): string | undefined {
	return error instanceof Error && 'code' in error && typeof error.code === 'string'
		? error.code
		: undefined
}

async function unlinkIfPresent(fs: FileSystem, path: string): Promise<void> {
	try {
		await fs.unlink(path)
	} catch (error) {
		if (getErrorCode(error) !== 'ENOENT') throw error
	}
}

async function verifiedExtractedPaths(
	fs: FileSystem,
	stagingDir: string,
	entryPaths: readonly string[],
): Promise<string[]> {
	const paths = [...new Set(entryPaths
		.map(normalizeArchiveEntryPath)
		.filter(path => !isExcludedGitPath(path)))]
	const verify = async () => {
		for (const path of paths) {
			const stats = await fs.stat(join(stagingDir, path))
			if (!stats.isFile()) {
				throw new Error(`ZIP extraction did not produce a regular file: ${path}`)
			}
		}
	}

	await (fs.scopeReads ? fs.scopeReads(verify) : verify())
	return paths
}

async function resolveTargetDir(targetDir: ResourcesTargetDir | undefined, args: ResourcesTargetDirArgs): Promise<string> {
	const baseDir = args.workspaceDir ?? args.sessionDir
	if (targetDir === undefined) return baseDir

	const raw = typeof targetDir === 'function'
		? await targetDir(args)
		: targetDir
	return resolve(baseDir, raw)
}

export const resourcesPlugin = definePlugin('resources')
	.pluginConfig<ResourcesPluginConfig>()
	.events([resourceEvents])
	.state<ResourcesState>({
		key: 'resources',
		initial: (): ResourcesState => ({ resources: [] }),
		reduce: (state, event) => {
			if (event.type === 'resource_injected') {
				const resource: InjectedResource = {
					resourceId: event.resourceId,
					slug: event.slug,
					name: event.name,
					filename: event.filename,
					mimeType: event.mimeType,
					paths: event.paths,
					targetDir: event.targetDir,
					injectedAt: event.injectedAt,
				}
				return { resources: [...state.resources, resource] }
			}
			return state
		},
	})
	.method('inject', {
		input: z.object({
			sessionId: z.string(),
			filename: z.string(),
			mimeType: z.string(),
			size: z.number(),
			fileBuffer: z.custom<Buffer>(),
			metadata: z.object({
				slug: z.string().optional(),
				name: z.string().optional(),
			}).optional(),
		}).superRefine((input, refinement) => {
			if (input.mimeType !== 'application/zip' && !ResourceBasenameSchema.safeParse(input.filename).success) {
				refinement.addIssue({
					code: 'custom',
					path: ['filename'],
					message: 'Resource filename must be a basename',
				})
			}
		}),
		output: z.object({
			resourceId: z.string(),
			paths: z.array(z.string()),
		}),
		handler: async (ctx, input) => {
			const fs = ctx.platform.fs
			const exec = makeExec(ctx.platform.process)
			const targetDir = await resolveTargetDir(ctx.pluginConfig?.targetDir, {
				sessionId: String(ctx.sessionId),
				sessionDir: ctx.environment.sessionDir,
				workspaceDir: ctx.environment.workspaceDir,
			})
			const resourceId = crypto.randomUUID()
			let paths: string[]
			let manifest: ResourceManifest | null = null

			if (input.mimeType === 'application/zip') {
				const tempRoot = join(ctx.environment.sessionDir, `_tmp_resource_${resourceId}`)
				const tempPath = join(tempRoot, 'resource.zip')
				const stagingDir = join(tempRoot, 'staging')

				try {
					await fs.mkdir(stagingDir, { recursive: true })
					await fs.writeFile(tempPath, input.fileBuffer)

					const inspection = await inspectZipArchive(ctx.platform.process, tempPath, {
						timeoutMs: ARCHIVE_TIMEOUT_MS,
						limits: ctx.pluginConfig?.archiveLimits,
					})
					if (!inspection.ok) {
						throw new Error(`ZIP inspection failed: ${inspection.error.message}`, { cause: inspection.error })
					}

					// `-x .git .git/*` so a stray .git entry in the ZIP can't overwrite the
					// worktree's gitdir pointer (which silently breaks every subsequent git
					// command in the workspace).
					await exec('unzip', ['-q', tempPath, '-d', stagingDir, '-x', '.git', '.git/*'])

					paths = await verifiedExtractedPaths(
						fs,
						stagingDir,
						inspection.value.entries
							.filter(entry => entry.type === 'file')
							.map(entry => entry.name),
					)

					const manifestPath = join(stagingDir, RESOURCE_MANIFEST_FILENAME)
					try {
						const raw = await fs.readFile(manifestPath, 'utf-8')
						manifest = ResourceManifestSchema.parse(JSON.parse(raw))
						ctx.logger.info('resources.inject: loaded resource manifest', {
							filename: RESOURCE_MANIFEST_FILENAME,
							postInjectRules: manifest.postInject?.length ?? 0,
						})
					} catch (error) {
						if (getErrorCode(error) !== 'ENOENT') {
							ctx.logger.warn('resources.inject: invalid resource manifest, skipping', {
								filename: RESOURCE_MANIFEST_FILENAME,
								error: error instanceof Error ? error.message : String(error),
							})
						}
					} finally {
						await unlinkIfPresent(fs, manifestPath)
					}

					paths = paths.filter(path => normalizeArchiveEntryPath(path) !== RESOURCE_MANIFEST_FILENAME)
					// Exclude every root .git spelling before promoting the complete staging tree.
					await fs.rm(join(stagingDir, '.git'), { recursive: true, force: true })
					await fs.cp(stagingDir, targetDir, { recursive: true, force: true })
				} finally {
					await fs.rm(tempRoot, { recursive: true, force: true })
				}
			} else {
				// Keep this check adjacent to the filesystem write as defense in depth.
				ResourceBasenameSchema.parse(input.filename)
				await fs.mkdir(targetDir, { recursive: true })
				const filePath = join(targetDir, input.filename)
				await fs.writeFile(filePath, input.fileBuffer)
				paths = [input.filename]
			}

			const postInjectCtx: PostInjectContext = {
				targetDir,
				sessionDir: ctx.environment.sessionDir,
				paths,
				filename: input.filename,
				mimeType: input.mimeType,
				logger: ctx.logger,
				exec,
				fs,
			}

			if (ctx.pluginConfig?.postInject) {
				await ctx.pluginConfig.postInject(postInjectCtx)
			}

			if (manifest?.postInject && manifest.postInject.length > 0) {
				await postInjectRules(manifest.postInject)(postInjectCtx)
			}

			await ctx.emitEvent(resourceEvents.create('resource_injected', {
				resourceId,
				slug: input.metadata?.slug,
				name: input.metadata?.name,
				filename: input.filename,
				mimeType: input.mimeType,
				paths,
				targetDir,
				injectedAt: Date.now(),
			}))

			return Ok({ resourceId, paths })
		},
	})
	.systemPrompt((ctx) => {
		const { resources } = ctx.pluginState
		if (resources.length === 0) return null

		const lines = resources.map(r => {
			const label = r.name ?? r.slug ?? r.filename
			const target = r.targetDir ? ` in \`${r.targetDir}\`` : ''
			return `- **${label}** (${r.filename}): ${r.paths.length} files${target}`
		})
		const targetDirs = [...new Set(resources.flatMap((r) => r.targetDir ? [r.targetDir] : []))]
		const targetSummary = targetDirs.length === 1
			? `\`${targetDirs[0]}\``
			: targetDirs.length > 1 ? 'multiple target directories' : 'the configured target directory'

		return `## Injected Resources\n\nThe following resources have been extracted into your workspace (${targetSummary}):\n${lines.join('\n')}\n\nThese files are ready to use. Explore them with the filesystem tools.`
	})
	.build()
