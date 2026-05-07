/**
 * ZIP Preprocessor
 *
 * Extracts ZIP contents via `unzip` CLI and recursively preprocesses files.
 * Each extracted file is processed by its matching preprocessor (markitdown for
 * documents, image classifier for images, nested zip for archives).
 * Full manifest is written to disk; extractedContent contains a structured summary.
 */

import { extname } from 'node:path'
import { mapWithConcurrency } from '~/lib/utils/concurrency.js'
import type { Result } from '~/lib/utils/result.js'
import { Err, Ok } from '~/lib/utils/result.js'
import type { ProcessRunner } from '~/platform/process.js'
import type { Logger } from '../../../lib/logger/logger.js'
import type { Preprocessor, PreprocessorContext, PreprocessorRegistry, PreprocessorResult } from '../preprocessor.js'

const MAX_DEPTH = 3
const MAX_FILES = 500
const MAX_TOTAL_SIZE = 100 * 1024 * 1024 // 100MB
const ZIP_FILE_CONCURRENCY = 10

const MIME_MAP: Record<string, string> = {
	'.pdf': 'application/pdf',
	'.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	'.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	'.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	'.odt': 'application/vnd.oasis.opendocument.text',
	'.rtf': 'application/rtf',
	'.epub': 'application/epub+zip',
	'.zip': 'application/zip',
	'.html': 'text/html',
	'.htm': 'text/html',
	'.csv': 'text/csv',
	'.json': 'application/json',
	'.xml': 'application/xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.txt': 'text/plain',
	'.md': 'text/markdown',
}

function getMimeType(filename: string): string | null {
	const ext = extname(filename).toLowerCase()
	return MIME_MAP[ext] ?? null
}

function makeExec(processRunner: ProcessRunner) {
	return (cmd: string, args: string[]) => processRunner.execFile(cmd, args, { timeout: 60_000, maxBuffer: 50 * 1024 * 1024 })
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

export interface ZipPreprocessorConfig {
	registry: PreprocessorRegistry
	logger: Logger
	process: ProcessRunner
	depth?: number
}

export class ZipPreprocessor implements Preprocessor {
	readonly name = 'zip'
	readonly supportedMimeTypes = ['application/zip']

	private readonly registry: PreprocessorRegistry
	private readonly logger: Logger
	private readonly processRunner: ProcessRunner
	private readonly exec: (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>
	private readonly depth: number

	constructor(config: ZipPreprocessorConfig) {
		this.registry = config.registry
		this.logger = config.logger
		this.processRunner = config.process
		this.exec = makeExec(config.process)
		this.depth = config.depth ?? 0
	}

	async process(
		filePath: string,
		_mimeType: string,
		ctx: PreprocessorContext,
	): Promise<Result<PreprocessorResult, Error>> {
		if (this.depth >= MAX_DEPTH) {
			return Err(new Error(`ZIP nesting depth limit reached (max ${MAX_DEPTH})`))
		}

		// Extract to disk via unzip
		const extractStore = ctx.files.scoped('extracted')
		const extractDirResult = extractStore.realPath('')
		if (!extractDirResult.ok) {
			return Err(new Error('Failed to resolve extraction directory'))
		}

		try {
			await this.exec('unzip', ['-o', '-q', filePath, '-d', extractDirResult.value])
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			if (message.includes('ENOENT')) {
				return Err(new Error('unzip not found'))
			}
			// unzip returns exit code 1 for warnings (e.g. skipped dirs) — still usable
			if (!message.includes('exit code 1')) {
				return Err(new Error(`unzip failed: ${message}`))
			}
		}

		// List extracted files
		const listResult = await extractStore.list('', { maxDepth: 10 })
		if (!listResult.ok) {
			return Err(new Error('Failed to list extracted files'))
		}

		const files = listResult.value
			.filter(e => e.type === 'file')
			.sort((a, b) => a.name.localeCompare(b.name))

		// Pick eligible files first (limits depend on cumulative iteration order, so this stays sequential)
		const eligible: typeof files = []
		let totalSize = 0
		let truncationNotice: string | null = null

		for (const file of files) {
			if (eligible.length >= MAX_FILES) {
				truncationNotice = `... (truncated, ${files.length - eligible.length} more files)`
				break
			}
			const fileSize = file.size ?? 0
			if (totalSize + fileSize > MAX_TOTAL_SIZE) {
				truncationNotice = '... (total size limit reached)'
				break
			}
			totalSize += fileSize
			eligible.push(file)
		}

		const fileCount = eligible.length

		// Process eligible files in parallel with bounded concurrency
		const processed = await mapWithConcurrency(eligible, ZIP_FILE_CONCURRENCY, async (file) => {
			const collectedPaths: string[] = []

			const fileRealPath = extractStore.realPath(file.name)
			if (!fileRealPath.ok) {
				return {
					manifestEntry: `- ${file.name} (path resolution failed)`,
					derivedPaths: collectedPaths,
				}
			}

			const relativePath = `extracted/${file.name}`
			collectedPaths.push(relativePath)

			const mime = getMimeType(file.name)
			let contentSummary = ''

			if (mime) {
				// For nested ZIPs, create a new preprocessor with incremented depth
				let preprocessor = this.registry.getForMimeType(mime)
				if (mime === 'application/zip') {
					preprocessor = new ZipPreprocessor({
						registry: this.registry,
						logger: this.logger,
						process: this.processRunner,
						depth: this.depth + 1,
					})
				}

				if (preprocessor) {
					const subResult = await preprocessor.process(fileRealPath.value, mime, {
						files: ctx.files.scoped(`extracted/${file.name}-content`),
					})
					if (subResult.ok) {
						if (subResult.value.derivedPaths) {
							for (const dp of subResult.value.derivedPaths) {
								collectedPaths.push(`extracted/${file.name}-content/${dp}`)
							}
						}
						if (subResult.value.extractedContent) {
							// Indent sub-content as nested lines, strip "Extracted files:" prefix
							const subContent = subResult.value.extractedContent.replace(/^Extracted files:\n/m, '')
							const indented = subContent.split('\n').map(l => `  ${l}`).join('\n')
							contentSummary = `\n${indented}`
						}
					} else {
						this.logger.warn('Sub-preprocessor failed', { file: file.name, error: subResult.error.message })
					}
				}
			}

			return {
				manifestEntry: `- ${file.name} (${formatSize(file.size ?? 0)})${contentSummary}`,
				derivedPaths: collectedPaths,
			}
		})

		const derivedPaths: string[] = []
		const manifest: string[] = []
		for (const item of processed) {
			derivedPaths.push(...item.derivedPaths)
			manifest.push(item.manifestEntry)
		}
		if (truncationNotice) manifest.push(truncationNotice)

		const fullManifest = `## ZIP Contents (${fileCount} files)\n\n${manifest.join('\n')}`

		// Write full manifest to disk
		await ctx.files.write('content.txt', fullManifest)
		derivedPaths.push('content.txt')

		this.logger.debug('ZIP processed', {
			filePath,
			filesExtracted: fileCount,
			totalSize,
			depth: this.depth,
		})

		return Ok({
			extractedContent: fullManifest,
			derivedPaths,
		})
	}
}
