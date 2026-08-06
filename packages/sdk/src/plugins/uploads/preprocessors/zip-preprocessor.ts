/**
 * ZIP Preprocessor
 *
 * Extracts ZIP contents via `unzip` CLI and recursively preprocesses files.
 * Each extracted file is processed by its matching preprocessor (markitdown for
 * documents, image classifier for images, nested zip for archives).
 * Full manifest is written to disk; extractedContent contains a structured summary.
 */

import { extname } from 'node:path'
import { inspectZipArchive } from '~/lib/archive/index.js'
import { mapWithConcurrency } from '~/lib/utils/concurrency.js'
import type { Result } from '~/lib/utils/result.js'
import { Err, Ok } from '~/lib/utils/result.js'
import type { ProcessRunner } from '~/platform/process.js'
import type { Logger } from '../../../lib/logger/logger.js'
import {
	getPreprocessingSignal,
	preprocessingAbortError,
	type Preprocessor,
	type PreprocessorContext,
	type PreprocessorRegistry,
	type PreprocessorResult,
} from '../preprocessor.js'

const MAX_DEPTH = 3
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
	return (cmd: string, args: string[], signal?: AbortSignal) => processRunner.execFile(cmd, args, { timeout: 60_000, maxBuffer: 50 * 1024 * 1024, signal })
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
	private readonly exec: (cmd: string, args: string[], signal?: AbortSignal) => Promise<{ stdout: string; stderr: string }>
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
		const signal = getPreprocessingSignal(ctx)
		if (signal.aborted) return Err(preprocessingAbortError(signal))
		if (this.depth >= MAX_DEPTH) {
			return Err(new Error(`ZIP nesting depth limit reached (max ${MAX_DEPTH})`))
		}
		const inspection = await inspectZipArchive(this.processRunner, filePath, {
			signal,
		})
		if (!inspection.ok) {
			if (signal.aborted) return Err(preprocessingAbortError(signal))
			return Err(
				new Error(`ZIP inspection failed: ${inspection.error.message}`, {
					cause: inspection.error,
				}),
			)
		}
		if (signal.aborted) return Err(preprocessingAbortError(signal))

		// Extract to disk via unzip
		const extractStore = ctx.files.scoped('extracted')
		const extractDirResult = extractStore.realPath('')
		if (!extractDirResult.ok) {
			return Err(new Error('Failed to resolve extraction directory'))
		}
		if (signal.aborted) return Err(preprocessingAbortError(signal))

		try {
			await this.exec('unzip', ['-o', '-q', filePath, '-d', extractDirResult.value], signal)
		} catch (error) {
			if (signal.aborted) return Err(preprocessingAbortError(signal))
			const message = error instanceof Error ? error.message : String(error)
			if (message.includes('ENOENT')) {
				return Err(new Error('unzip not found'))
			}
			return Err(new Error(`unzip failed: ${message}`))
		}
		if (signal.aborted) return Err(preprocessingAbortError(signal))

		// List extracted files
		const listResult = await extractStore.list('', { maxDepth: 10 })
		if (!listResult.ok) {
			return Err(new Error('Failed to list extracted files'))
		}
		if (signal.aborted) return Err(preprocessingAbortError(signal))

		const files = listResult.value
			.filter(e => e.type === 'file')
			.sort((a, b) => a.name.localeCompare(b.name))

		const fileCount = files.length

		// Process files in parallel with bounded concurrency
		const processed = await mapWithConcurrency(files, ZIP_FILE_CONCURRENCY, async (file) => {
			const collectedPaths: string[] = []
			if (signal.aborted) {
				return { manifestEntry: '', derivedPaths: collectedPaths }
			}

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
						...ctx,
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
		if (signal.aborted) return Err(preprocessingAbortError(signal))

		const derivedPaths: string[] = []
		const manifest: string[] = []
		for (const item of processed) {
			derivedPaths.push(...item.derivedPaths)
			manifest.push(item.manifestEntry)
		}
		const fullManifest = `## ZIP Contents (${fileCount} files)\n\n${manifest.join('\n')}`

		// Write full manifest to disk
		if (signal.aborted) return Err(preprocessingAbortError(signal))
		await ctx.files.write('content.txt', fullManifest)
		derivedPaths.push('content.txt')

		this.logger.debug('ZIP processed', {
			filePath,
			filesExtracted: fileCount,
			totalSize: inspection.value.totalUncompressedSize,
			depth: this.depth,
		})

		return Ok({
			extractedContent: fullManifest,
			derivedPaths,
		})
	}
}
