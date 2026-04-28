import { join, relative } from 'node:path'
import z from 'zod/v4'
import { definePlugin } from '~/core/plugins/plugin-builder.js'
import { Ok } from '~/lib/utils/result.js'
import type { FileSystem } from '~/platform/fs.js'
import type { ProcessRunner } from '~/platform/process.js'
import { RESOURCE_MANIFEST_FILENAME, type ResourceManifest, ResourceManifestSchema } from './manifest.js'
import {
	type PostInjectContext,
	type PostInjectExecOptions,
	type PostInjectHook,
	postInjectRules,
} from './post-inject.js'
import { type InjectedResource, resourceEvents, type ResourcesState } from './state.js'

const MAX_LISTED_PATHS = 100

export interface ResourcesPluginConfig {
	targetDir?: string
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
			timeout: options?.timeout ?? 120_000,
			maxBuffer: 50 * 1024 * 1024,
			cwd: options?.cwd,
			env: options?.env ? { ...process.env, ...options.env } : undefined,
		})
	}
}

async function listFiles(fs: FileSystem, dir: string, maxEntries: number): Promise<string[]> {
	const results: string[] = []

	async function walk(current: string): Promise<void> {
		if (results.length >= maxEntries) return
		const entries = await fs.readdir(current, { withFileTypes: true })
		for (const entry of entries) {
			if (results.length >= maxEntries) break
			const fullPath = join(current, entry.name)
			if (entry.isDirectory()) {
				await walk(fullPath)
			} else {
				results.push(relative(dir, fullPath))
			}
		}
	}

	await walk(dir)
	return results
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
		}),
		output: z.object({
			resourceId: z.string(),
			paths: z.array(z.string()),
		}),
		handler: async (ctx, input) => {
			const fs = ctx.platform.fs
			const exec = makeExec(ctx.platform.process)
			const targetDir = ctx.pluginConfig?.targetDir ?? ctx.environment.workspaceDir ?? ctx.environment.sessionDir
			const resourceId = crypto.randomUUID()
			let paths: string[]

			if (input.mimeType === 'application/zip') {
				// Write to temp file, extract, clean up
				const tempPath = join(ctx.environment.sessionDir, `_tmp_resource_${resourceId}.zip`)
				await fs.writeFile(tempPath, input.fileBuffer)

				try {
					await exec('unzip', ['-o', '-q', tempPath, '-d', targetDir])
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error)
					// unzip returns exit code 1 for warnings — still usable
					if (!message.includes('exit code 1')) {
						await fs.unlink(tempPath).catch(() => {})
						throw new Error(`unzip failed: ${message}`)
					}
				}

				await fs.unlink(tempPath).catch(() => {})
				paths = await listFiles(fs, targetDir, MAX_LISTED_PATHS)
			} else {
				// Copy file directly to target dir
				const filePath = join(targetDir, input.filename)
				await fs.writeFile(filePath, input.fileBuffer)
				paths = [input.filename]
			}

			let manifest: ResourceManifest | null = null
			if (input.mimeType === 'application/zip') {
				const manifestPath = join(targetDir, RESOURCE_MANIFEST_FILENAME)
				try {
					const raw = await fs.readFile(manifestPath, 'utf-8')
					manifest = ResourceManifestSchema.parse(JSON.parse(raw))
					await fs.unlink(manifestPath).catch(() => {})
					paths = paths.filter((p) => p !== RESOURCE_MANIFEST_FILENAME)
					ctx.logger.info('resources.inject: loaded resource manifest', {
						filename: RESOURCE_MANIFEST_FILENAME,
						postInjectRules: manifest.postInject?.length ?? 0,
					})
				} catch (err) {
					const code = (err as NodeJS.ErrnoException)?.code
					if (code !== 'ENOENT') {
						ctx.logger.warn('resources.inject: invalid resource manifest, skipping', {
							filename: RESOURCE_MANIFEST_FILENAME,
							error: err instanceof Error ? err.message : String(err),
						})
					}
				}
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
				injectedAt: Date.now(),
			}))

			return Ok({ resourceId, paths })
		},
	})
	.systemPrompt((ctx) => {
		const { resources } = ctx.pluginState
		if (resources.length === 0) return null

		const targetDir = ctx.pluginConfig?.targetDir ?? ctx.environment.workspaceDir ?? ctx.environment.sessionDir
		const lines = resources.map(r => {
			const label = r.name ?? r.slug ?? r.filename
			return `- **${label}** (${r.filename}): ${r.paths.length} files`
		})

		return `## Injected Resources\n\nThe following resources have been extracted into your workspace (\`${targetDir}\`):\n${lines.join('\n')}\n\nThese files are ready to use. Explore them with the filesystem tools.`
	})
	.build()
