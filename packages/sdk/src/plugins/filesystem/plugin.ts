import { join, relative, resolve } from 'node:path'
import z from 'zod/v4'
import { agentEvents } from '~/core/agents/state.js'
import { ValidationErrors } from '~/core/errors.js'
import type { FileEntry } from '~/core/file-store/types.js'
import type { ToolResultContent } from '~/core/llm/llm-log-types.js'
import { truncateByTokens } from '~/core/llm/tokens.js'
import { definePlugin } from '~/core/plugins/plugin-builder.js'
import { createTool, type ToolDefinition } from '~/core/tools/definition.js'
import { getImageMimeType } from '~/lib/mime.js'
import { Err, Ok } from '~/lib/utils/result.js'
import type { Result } from '~/lib/utils/result.js'
import type { ToolError } from '../../core/tools/executor.js'
import {
	ALWAYS_IGNORED_NAMES,
	buildDirectoryListingPreamble,
	CALLS_DIR,
	checkDeniedPaths,
	EVENTS_DIR,
	fileEntryToTreeEntry,
	formatFlatListing,
	formatTreeRecursive,
	loadGitignoreViaStore,
	type TreeEntry,
} from './helpers.js'
import { listDirectory, listDirectoryRecursive, ListingError, preventTraversal } from './listing.js'

// ============================================================================
// Configuration
// ============================================================================

/**
 * Session-wide filesystem configuration.
 */
export interface FilesystemPresetConfig {
	/** Maximum file size to read (bytes) - files larger than this are rejected (default: 10MB) */
	maxReadSize?: number
	/** Allowed file extensions (empty = all allowed) */
	allowedExtensions?: string[]
	/** Denied path segments (e.g. [".events"]) */
	deniedPaths?: string[]
	/** Approximate max tokens before auto-truncating (default: 20000) */
	maxTokens?: number
	/** Respect .gitignore files when listing directories (default: true) */
	respectGitignore?: boolean
	/** Default enabled state for agents (default: true). Agents can override via FilesystemAgentConfig.enabled. */
	defaultEnabled?: boolean
	/** Whether write tools (write_file, replace_in_file) are available by default (default: true). Agents can override via FilesystemAgentConfig.writable. */
	writable?: boolean
}

/**
 * Agent-specific filesystem configuration.
 */
export interface FilesystemAgentConfig {
	/** Whether filesystem is enabled for this agent (default: true) */
	enabled?: boolean
	/** Whether write tools (write_file, replace_in_file) are available for this agent. Overrides preset-level writable when set. */
	writable?: boolean
	/** Emit a directory listing preamble when the agent starts. true uses default depth (1), or pass { maxDepth } to override. */
	directoryListing?: boolean | { maxDepth?: number }
}

// ============================================================================
// Zod Schemas
// ============================================================================

const directoryEntrySchema = z.object({
	name: z.string(),
	path: z.string().optional(),
	type: z.enum(['file', 'directory']),
	size: z.number(),
	mimeType: z.string().optional(),
})

const readFileInputSchema = z.object({
	path: z.string().describe('Absolute path to the file within session or workspace directory.'),
	offset: z.number().int().min(0).optional()
		.describe('Line offset to start reading from (0-based). Defaults to 0.'),
	maxLines: z.number().int().min(1).optional()
		.describe('Maximum number of lines to return. If omitted, returns the entire file.'),
})

const writeFileInputSchema = z.object({
	path: z.string().describe('Absolute path to the file within session or workspace directory.'),
	content: z.string().describe('Content to write'),
	encoding: z.enum(['utf-8', 'base64']).optional()
		.describe('Content encoding (utf-8 for text, base64 for binary). Defaults to utf-8.'),
	createDirs: z.boolean().optional()
		.describe("Create parent directories if they don't exist. Defaults to true."),
})

const listDirectoryInputSchema = z.object({
	path: z.string().describe('Absolute path to the directory within session or workspace directory.'),
	recursive: z.boolean().optional()
		.describe('List contents recursively. Defaults to false.'),
	includeHidden: z.boolean().optional()
		.describe('Include hidden files (starting with .). Defaults to false.'),
})

const replaceInFileInputSchema = z.object({
	path: z.string().describe('Absolute path to the file.'),
	searchValue: z.string().describe('Exact text to find.'),
	replaceValue: z.string().describe('Text to replace with.'),
	expectedOccurrences: z.number().int().min(1).optional().describe('Expected number of occurrences. Aborts if actual count differs.'),
})

// ============================================================================
// Filesystem Plugin
// ============================================================================

export const filesystemPlugin = definePlugin('filesystem')
	.pluginConfig<FilesystemPresetConfig>()
	.context(async () => {
		return {} // No plugin-specific context needed
	})
	.agentConfig<FilesystemAgentConfig>()
	.tools((ctx) => {
		const pluginConfig = ctx.pluginConfig ?? {}
		const defaultEnabled = pluginConfig.defaultEnabled ?? true
		const agentEnabled = ctx.pluginAgentConfig?.enabled ?? defaultEnabled
		if (!agentEnabled) return []

		const deniedPaths = pluginConfig.deniedPaths ?? [EVENTS_DIR, CALLS_DIR]
		const maxReadSize = pluginConfig.maxReadSize ?? 10 * 1024 * 1024 // 10MB default
		const maxTokens = pluginConfig.maxTokens ?? 20_000
		// Reserve 10% for JSON envelope/metadata so result-eviction plugin doesn't double-truncate
		const contentTokenBudget = Math.floor(maxTokens * 0.9)
		const respectGitignore = pluginConfig.respectGitignore ?? true
		const writable = ctx.pluginAgentConfig?.writable ?? pluginConfig.writable ?? true

		const tools: ToolDefinition<any>[] = [
			// read_file tool
			createTool({
				name: 'read_file',
				description: 'Read the contents of a file. For image files, the image is returned visually. For other binary files, only metadata is returned.',
				input: readFileInputSchema,
				execute: async (input, context): Promise<Result<ToolResultContent, ToolError>> => {
					const denied = checkDeniedPaths(input.path, deniedPaths)
					if (!denied.ok) return denied

					const fileStore = context.files

					const statResult = await fileStore.stat(input.path)
					if (!statResult.ok) {
						return Err({
							message: statResult.error,
							recoverable: false,
						})
					}

					const stats = statResult.value

					if (stats.type !== 'file') {
						return Err({
							message: `'${input.path}' is not a file`,
							recoverable: false,
						})
					}

					// Image files → return as multimodal image content
					const mimeType = getImageMimeType(input.path)
					if (mimeType) {
						const realPathResult = fileStore.realPath(input.path)
						if (!realPathResult.ok) {
							return Err({ message: realPathResult.error, recoverable: false })
						}
						return Ok([
							{ type: 'text', text: `Image: ${input.path} (${mimeType}, ${stats.size} bytes)` },
							{ type: 'image_url', imageUrl: { url: `file://${realPathResult.value}` } },
						])
					}

					// Reject files that are too large to read into memory
					if ((stats.size ?? 0) > maxReadSize) {
						return Err({
							message: `File is too large (${stats.size} bytes, max ${maxReadSize}). Use offset and maxLines to read specific sections.`,
							recoverable: true,
						})
					}

					// Read as text
					const readResult = await fileStore.read(input.path)
					if (!readResult.ok) {
						return Err({ message: readResult.error, recoverable: false })
					}

					const rawContent = readResult.value as string

					// Detect binary content (null bytes in first 8KB)
					if (rawContent.slice(0, 8192).includes('\0')) {
						return Ok(JSON.stringify({ path: input.path, type: 'binary', size: stats.size }, null, 2))
					}

					let content = rawContent
					const hasExplicitRange = input.offset !== undefined || input.maxLines !== undefined
					const lines = content.split('\n')
					const totalLines = lines.length

					// Auto-truncate files exceeding maxTokens when no explicit range is specified
					const truncation = !hasExplicitRange ? truncateByTokens(content, contentTokenBudget) : null
					if (truncation) {
						return Ok(JSON.stringify(
							{
								content: truncation.content,
								size: stats.size,
								truncated: true,
								totalLines,
								instructions:
									`File is large (${totalLines} lines, ~${truncation.originalTokens} tokens). Use offset and maxLines parameters to read specific sections.`,
							},
							null,
							2,
						))
					}

					let truncated = false
					if (hasExplicitRange) {
						const start = input.offset ?? 0
						const end = input.maxLines !== undefined ? start + input.maxLines : totalLines
						const sliced = lines.slice(start, end)
						truncated = end < totalLines
						content = sliced.join('\n')
					}

					// Cap explicit range results to maxTokens as well
					const rangeTruncation = truncateByTokens(content, contentTokenBudget)
					if (rangeTruncation) {
						content = rangeTruncation.content
						truncated = true
					}

					return Ok(JSON.stringify(
						{
							content,
							size: stats.size,
							...(truncated ? { truncated: true } : {}),
							...(hasExplicitRange || truncated ? { totalLines } : {}),
						},
						null,
						2,
					))
				},
			}),

			// list_directory tool
			createTool({
				name: 'list_directory',
				description: 'List the contents of a directory. Returns a compact tree view.',
				input: listDirectoryInputSchema,
				execute: async (input, context): Promise<Result<ToolResultContent, ToolError>> => {
					const denied = checkDeniedPaths(input.path, deniedPaths)
					if (!denied.ok) return denied

					const fileStore = context.files
					const recursive = input.recursive ?? false
					const includeHidden = input.includeHidden ?? false

					const statResult = await fileStore.stat(input.path)
					if (!statResult.ok) {
						return Err({
							message: statResult.error,
							recoverable: false,
						})
					}

					if (statResult.value.type !== 'directory') {
						return Err({
							message: `'${input.path}' is not a directory`,
							recoverable: false,
						})
					}

					const roots = fileStore.getRoots()
					const containingRoot = roots.workspace
							&& (input.path === roots.workspace || input.path.startsWith(roots.workspace + '/'))
						? roots.workspace
						: roots.session
					const ig = respectGitignore ? await loadGitignoreViaStore(input.path, containingRoot, fileStore) : null

					async function collectEntries(dirPath: string): Promise<TreeEntry[]> {
						const listResult = await fileStore.list(dirPath)
						if (!listResult.ok) return []

						const entries: TreeEntry[] = []
						for (const item of listResult.value as FileEntry[]) {
							if (ALWAYS_IGNORED_NAMES.has(item.name)) continue
							if (!includeHidden && item.name.startsWith('.')) continue
							if (deniedPaths.includes(item.name)) continue

							const itemRelative = relative(input.path, join(dirPath, item.name))

							if (ig) {
								const testPath = item.type === 'directory' ? `${itemRelative}/` : itemRelative
								if (ig.ignores(testPath)) continue
							}

							const treeEntry = fileEntryToTreeEntry(item)
							if (item.type === 'directory' && recursive) {
								treeEntry.children = await collectEntries(join(dirPath, item.name))
							}
							entries.push(treeEntry)
						}

						return entries
					}

					const entries = await collectEntries(input.path)

					let output: string
					if (recursive) {
						output = `${input.path}/\n${formatTreeRecursive(entries, '')}`
					} else {
						output = `${input.path}/\n${formatFlatListing(entries)}`
					}

					return Ok(output)
				},
			}),
		]

		if (writable) {
			tools.push(
				// write_file tool
				createTool({
					name: 'write_file',
					description:
						"Write content to a file. Automatically creates parent directories — no need to mkdir first. Creates the file if it doesn't exist, overwrites if it does.",
					input: writeFileInputSchema,
					execute: async (input, context): Promise<Result<ToolResultContent, ToolError>> => {
						const denied = checkDeniedPaths(input.path, deniedPaths)
						if (!denied.ok) return denied

						const fileStore = context.files
						const encoding = input.encoding ?? 'utf-8'

						const buffer = encoding === 'base64'
							? Buffer.from(input.content, 'base64')
							: input.content

						const writeResult = await fileStore.write(input.path, buffer)
						if (!writeResult.ok) {
							return Err({
								message: `Failed to write file: ${writeResult.error}`,
								recoverable: false,
							})
						}

						// Get size after write
						const statResult = await fileStore.stat(input.path)
						const size = statResult.ok ? statResult.value.size : Buffer.byteLength(typeof buffer === 'string' ? buffer : buffer)

						return Ok(JSON.stringify({ path: input.path, size }, null, 2))
					},
				}),
				// replace_in_file tool
				createTool({
					name: 'replace_in_file',
					description:
						'Replace text in a file. More efficient and safer than write_file for targeted changes. Use write_file only for new files or complete rewrites.',
					input: replaceInFileInputSchema,
					execute: async (input, context): Promise<Result<ToolResultContent, ToolError>> => {
						const denied = checkDeniedPaths(input.path, deniedPaths)
						if (!denied.ok) return denied

						const fileStore = context.files

						const readResult = await fileStore.read(input.path)
						if (!readResult.ok) {
							return Err({ message: readResult.error, recoverable: false })
						}

						const content = readResult.value as string
						const parts = content.split(input.searchValue)
						const occurrences = parts.length - 1

						if (occurrences === 0) {
							return Err({ message: 'No occurrences found', recoverable: true })
						}

						if (input.expectedOccurrences !== undefined && occurrences !== input.expectedOccurrences) {
							return Err({
								message: `Expected ${input.expectedOccurrences} occurrences, but found ${occurrences}`,
								recoverable: true,
							})
						}

						const newContent = parts.join(input.replaceValue)
						const writeResult = await fileStore.write(input.path, newContent)
						if (!writeResult.ok) {
							return Err({ message: `Failed to write file: ${writeResult.error}`, recoverable: false })
						}

						return Ok(`Replaced ${occurrences} occurrence${occurrences === 1 ? '' : 's'}`)
					},
				}),
			)
		}

		return tools
	})
	.method('listSession', {
		input: z.object({ path: z.string().optional() }),
		output: z.object({
			entries: z.array(directoryEntrySchema),
			path: z.string(),
			root: z.literal('session'),
		}),
		handler: async (ctx, input) => {
			const baseDir = ctx.environment.sessionDir
			try {
				const entries = await listDirectory(ctx.platform.fs, baseDir, input.path ?? '')
				return Ok({ entries, path: input.path ?? '', root: 'session' })
			} catch (e) {
				if (e instanceof ListingError) {
					return Err(ValidationErrors.invalid(e.message))
				}
				throw e
			}
		},
	})
	.method('listWorkspace', {
		input: z.object({ path: z.string().optional(), recursive: z.boolean().optional() }),
		output: z.object({
			entries: z.array(directoryEntrySchema),
			path: z.string(),
			root: z.literal('workspace'),
		}),
		handler: async (ctx, input) => {
			const workspaceDir = ctx.environment.workspaceDir
			if (!workspaceDir) {
				return Err(ValidationErrors.invalid('No workspace configured for this session'))
			}
			const resolvedWorkspace = resolve(workspaceDir)
			const subPath = input.path ?? ''

			try {
				if (input.recursive) {
					const targetDir = subPath ? preventTraversal(resolvedWorkspace, subPath) : resolvedWorkspace
					if (!targetDir) {
						return Err(ValidationErrors.invalid('Path traversal not allowed'))
					}
					const entries = await listDirectoryRecursive(ctx.platform.fs, targetDir)
					return Ok({ entries, path: subPath, root: 'workspace' })
				}
				const entries = await listDirectory(ctx.platform.fs, resolvedWorkspace, subPath)
				return Ok({ entries, path: subPath, root: 'workspace' })
			} catch (e) {
				if (e instanceof ListingError) {
					return Err(ValidationErrors.invalid(e.message))
				}
				throw e
			}
		},
	})
	.hook('onStart', async (ctx) => {
		const pluginConfig = ctx.pluginConfig ?? {}
		const defaultEnabled = pluginConfig.defaultEnabled ?? true
		if (!(ctx.pluginAgentConfig?.enabled ?? defaultEnabled)) return null

		const dirListingConfig = ctx.pluginAgentConfig?.directoryListing
		if (!dirListingConfig) return null

		const maxDepth = typeof dirListingConfig === 'object' ? dirListingConfig.maxDepth : undefined
		const deniedPaths = pluginConfig.deniedPaths ?? [EVENTS_DIR, CALLS_DIR]
		const content = await buildDirectoryListingPreamble(ctx.files, { maxDepth, deniedPaths })

		await ctx.emitEvent(agentEvents.create('preamble_added', {
			agentId: ctx.agentId,
			messages: [{ role: 'user', content }],
		}))

		return null
	})
	.build()
