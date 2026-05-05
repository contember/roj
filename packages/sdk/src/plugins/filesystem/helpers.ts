import ignore, { type Ignore } from 'ignore'
import { join, relative } from 'node:path'
import type { FileEntry, FileStore } from '~/core/file-store/types.js'
import type { ToolError } from '../../core/tools/executor.js'
import { Err, Ok, Result } from '../../lib/utils/result.js'

// ============================================================================
// Constants
// ============================================================================

export const EVENTS_DIR = '.events'
export const CALLS_DIR = 'calls'

/** Directory/file names that are always skipped when listing, regardless of gitignore. */
export const ALWAYS_IGNORED_NAMES = new Set(['node_modules'])

// ============================================================================
// Path validation
// ============================================================================

export function checkDeniedPaths(
	path: string,
	deniedPaths: string[],
): Result<void, ToolError> {
	for (const denied of deniedPaths) {
		if (path.includes(`/${denied}/`) || path.endsWith(`/${denied}`)) {
			return Err({
				message: `Access to '${path}' is denied`,
				recoverable: false,
			})
		}
	}
	return Ok(undefined)
}

// ============================================================================
// Gitignore Support
// ============================================================================

/**
 * Load .gitignore patterns from `dir` up to (and including) `rootDir`.
 * Returns an `ignore` instance with all collected rules.
 * Uses FileStore for reading .gitignore files.
 */
export async function loadGitignoreViaStore(dir: string, rootDir: string, fileStore: FileStore): Promise<Ignore> {
	const ig = ignore()

	// Build list of .gitignore paths from dir up to rootDir
	const gitignorePaths: string[] = []
	let current = dir
	while (current.startsWith(rootDir)) {
		gitignorePaths.push(join(current, '.gitignore'))
		const parent = join(current, '..')
		// Normalize to prevent infinite loop
		if (parent === current || parent.length >= current.length) break
		current = parent
	}

	// Process from root to leaf so deeper rules override shallower ones
	for (const gitignorePath of gitignorePaths.reverse()) {
		const readResult = await fileStore.read(gitignorePath)
		if (!readResult.ok) continue // .gitignore doesn't exist at this level

		const content = readResult.value as string
		const relativeTo = join(gitignorePath, '..')
		const prefix = relative(dir, relativeTo)
		if (prefix === '') {
			ig.add(content)
		} else {
			for (const line of content.split('\n')) {
				const trimmed = line.trim()
				if (trimmed === '' || trimmed.startsWith('#')) continue
				const isNegation = trimmed.startsWith('!')
				const pattern = isNegation ? trimmed.slice(1) : trimmed
				const rewritten = `${prefix}/${pattern}`
				ig.add(isNegation ? `!${rewritten}` : rewritten)
			}
		}
	}

	return ig
}

// ============================================================================
// Tree Formatting
// ============================================================================

export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

export interface TreeEntry {
	name: string
	type: 'file' | 'directory' | 'symlink' | 'other'
	size?: number
	children?: TreeEntry[]
}

export function formatTreeRecursive(entries: TreeEntry[], prefix: string): string {
	const lines: string[] = []
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i]
		const isLast = i === entries.length - 1
		const connector = isLast ? '└── ' : '├── '
		const childPrefix = isLast ? '    ' : '│   '

		if (entry.type === 'directory') {
			lines.push(`${prefix}${connector}${entry.name}/`)
			if (entry.children) {
				lines.push(formatTreeRecursive(entry.children, prefix + childPrefix))
			}
		} else {
			const sizeStr = entry.size !== undefined ? ` (${formatSize(entry.size)})` : ''
			lines.push(`${prefix}${connector}${entry.name}${sizeStr}`)
		}
	}
	return lines.join('\n')
}

export function formatFlatListing(entries: TreeEntry[]): string {
	const lines: string[] = []
	for (const entry of entries) {
		if (entry.type === 'directory') {
			lines.push(`  ${entry.name}/          [dir]`)
		} else {
			const sizeStr = entry.size !== undefined ? formatSize(entry.size) : ''
			lines.push(`  ${entry.name}  ${sizeStr}`)
		}
	}
	return lines.join('\n')
}

export function fileEntryToTreeEntry(entry: FileEntry): TreeEntry {
	return {
		name: entry.name,
		type: entry.type,
		size: entry.size,
	}
}

// ============================================================================
// Recursive tree collection
// ============================================================================

export async function collectTreeEntries(
	fileStore: FileStore,
	dirPath: string,
	rootPath: string,
	options: {
		maxDepth?: number
		includeHidden?: boolean
		deniedPaths?: string[]
		ig?: Ignore | null
	},
	depth = 0,
): Promise<TreeEntry[]> {
	if (options.maxDepth !== undefined && depth >= options.maxDepth) return []

	const listResult = await fileStore.list(dirPath)
	if (!listResult.ok) return []

	const entries: TreeEntry[] = []
	for (const item of listResult.value) {
		if (ALWAYS_IGNORED_NAMES.has(item.name)) continue
		if (!options.includeHidden && item.name.startsWith('.')) continue
		if (options.deniedPaths?.includes(item.name)) continue

		if (options.ig) {
			const itemRelative = relative(rootPath, join(dirPath, item.name))
			const testPath = item.type === 'directory' ? `${itemRelative}/` : itemRelative
			if (options.ig.ignores(testPath)) continue
		}

		const treeEntry = fileEntryToTreeEntry(item)
		if (item.type === 'directory') {
			const children = await collectTreeEntries(
				fileStore,
				join(dirPath, item.name),
				rootPath,
				options,
				depth + 1,
			)
			if (children.length > 0) {
				treeEntry.children = children
			}
		}
		entries.push(treeEntry)
	}

	return entries
}

// ============================================================================
// Directory listing preamble
// ============================================================================

export async function buildDirectoryListingPreamble(
	fileStore: FileStore,
	options?: { maxDepth?: number; deniedPaths?: string[] },
): Promise<string> {
	const maxDepth = options?.maxDepth ?? 1
	const deniedPaths = options?.deniedPaths
	const parts: string[] = ['## Directory Structure\n']
	const roots = fileStore.getRoots()

	if (roots.workspace) {
		const ig = await loadGitignoreViaStore(roots.workspace, roots.workspace, fileStore)
		const entries = await collectTreeEntries(fileStore, roots.workspace, roots.workspace, { maxDepth, ig, deniedPaths })
		const tree = formatTreeRecursive(entries, '')
		parts.push(`### Workspace (${roots.workspace})\n\`\`\`\n${roots.workspace}/\n${tree}\n\`\`\`\n`)
	}

	const sessionEntries = await collectTreeEntries(fileStore, roots.session, roots.session, { maxDepth, deniedPaths })
	const sessionTree = formatTreeRecursive(sessionEntries, '')
	parts.push(`### Session (${roots.session})\n\`\`\`\n${roots.session}/\n${sessionTree}\n\`\`\``)

	return parts.join('\n')
}
