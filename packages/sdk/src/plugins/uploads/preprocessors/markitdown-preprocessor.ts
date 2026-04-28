/**
 * Markitdown Preprocessor
 *
 * Converts documents to markdown using Microsoft's markitdown CLI.
 * Supports PDF, DOCX, XLSX, PPTX, HTML, CSV, JSON, XML, EPUB, and more.
 *
 * Image extraction:
 * - PDF: uses pdfimages (poppler-utils)
 * - DOCX/ODT/EPUB: uses pandoc --extract-media
 *
 * Extracted images are classified via the image classifier preprocessor.
 * Full content is written to disk; extractedContent contains a structured manifest.
 */

import { dirname } from 'node:path'
import type { Result } from '~/lib/utils/result.js'
import { Err, Ok } from '~/lib/utils/result.js'
import type { FileSystem } from '~/platform/fs.js'
import type { ProcessRunner } from '~/platform/process.js'
import type { FileStore } from '../../../core/file-store/types.js'
import type { Logger } from '../../../lib/logger/logger.js'
import type { Preprocessor, PreprocessorContext, PreprocessorRegistry, PreprocessorResult } from '../preprocessor.js'

const MAX_IMAGES = 50

function makeExec(processRunner: ProcessRunner) {
	return (cmd: string, args: string[]) => processRunner.execFile(cmd, args, { timeout: 60_000, maxBuffer: 50 * 1024 * 1024 })
}

/** MIME types where markitdown converts to markdown (non-ZIP, non-image) */
const SUPPORTED_MIME_TYPES = [
	'application/pdf',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	'application/vnd.oasis.opendocument.text',
	'application/rtf',
	'application/epub+zip',
	'text/html',
	'application/xhtml+xml',
	'text/csv',
	'application/json',
	'application/xml',
	'text/xml',
]

/** MIME types where pandoc can extract embedded media */
const PANDOC_EXTRACT_MIMES = new Set([
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	'application/vnd.oasis.opendocument.text',
	'application/epub+zip',
])

const PANDOC_FORMAT_MAP: Record<string, string> = {
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
	'application/vnd.oasis.opendocument.text': 'odt',
	'application/epub+zip': 'epub',
}

/** MIME types where pdfimages can extract images */
const PDFIMAGES_MIMES = new Set([
	'application/pdf',
])

export interface MarkitdownPreprocessorConfig {
	registry: PreprocessorRegistry
	logger: Logger
	fs: FileSystem
	process: ProcessRunner
}

export class MarkitdownPreprocessor implements Preprocessor {
	readonly name = 'markitdown'
	readonly supportedMimeTypes = SUPPORTED_MIME_TYPES

	private readonly registry: PreprocessorRegistry
	private readonly logger: Logger
	private readonly fs: FileSystem
	private readonly exec: (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>

	constructor(config: MarkitdownPreprocessorConfig) {
		this.registry = config.registry
		this.logger = config.logger
		this.fs = config.fs
		this.exec = makeExec(config.process)
	}

	async process(
		filePath: string,
		mimeType: string,
		ctx: PreprocessorContext,
	): Promise<Result<PreprocessorResult, Error>> {
		const derivedPaths: string[] = []
		const imageEntries: string[] = []

		// 1. Convert to markdown via markitdown
		const contentPathResult = ctx.files.realPath('content.md')
		if (!contentPathResult.ok) {
			return Err(new Error('Failed to resolve output path'))
		}

		try {
			await this.fs.mkdir(dirname(contentPathResult.value), { recursive: true })
			await this.exec('markitdown', [filePath, '-o', contentPathResult.value])
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			if (message.includes('ENOENT')) {
				return Err(new Error('markitdown not found. Install with: pip install "markitdown[all]"'))
			}
			return Err(new Error(`markitdown failed: ${message}`))
		}

		const contentResult = await ctx.files.read('content.md')
		const markdown = contentResult.ok ? contentResult.value : ''

		derivedPaths.push('content.md')

		// 2. Extract images based on file type
		if (PANDOC_EXTRACT_MIMES.has(mimeType)) {
			const images = await this.extractImagesWithPandoc(filePath, mimeType, ctx)
			for (const img of images) {
				derivedPaths.push(img.relativePath)
				imageEntries.push(`- ${img.relativePath} — ${img.description}`)
			}
		} else if (PDFIMAGES_MIMES.has(mimeType)) {
			const images = await this.extractImagesWithPdfimages(filePath, ctx)
			for (const img of images) {
				derivedPaths.push(img.relativePath)
				imageEntries.push(`- ${img.relativePath} — ${img.description}`)
			}
		}

		// 3. Build manifest
		const manifestLines: string[] = ['Extracted files:']
		manifestLines.push(`- content.md (markdown, ${markdown.length} chars)`)
		manifestLines.push(...imageEntries)

		this.logger.debug('Markitdown processed', {
			filePath,
			mimeType,
			contentLength: markdown.length,
			imagesExtracted: imageEntries.length,
		})

		return Ok({
			extractedContent: manifestLines.join('\n'),
			derivedPaths,
		})
	}

	private async extractImagesWithPandoc(
		filePath: string,
		mimeType: string,
		ctx: PreprocessorContext,
	): Promise<Array<{ relativePath: string; description: string }>> {
		const mediaStore = ctx.files.scoped('media')
		const mediaDirResult = mediaStore.realPath('')
		if (!mediaDirResult.ok) return []

		const format = PANDOC_FORMAT_MAP[mimeType]
		if (!format) return []

		try {
			await this.exec('pandoc', [
				'-f',
				format,
				'-t',
				'gfm',
				filePath,
				'-o',
				'/dev/null',
				`--extract-media=${mediaDirResult.value}`,
			])
		} catch {
			this.logger.warn('pandoc --extract-media failed', { filePath })
			return []
		}

		return classifyExtractedImages(mediaStore, 'media', ctx, this.registry, this.logger)
	}

	private async extractImagesWithPdfimages(
		filePath: string,
		ctx: PreprocessorContext,
	): Promise<Array<{ relativePath: string; description: string }>> {
		const imageStore = ctx.files.scoped('images')
		const imagesDirResult = imageStore.realPath('')
		if (!imagesDirResult.ok) return []

		try {
			await this.fs.mkdir(imagesDirResult.value, { recursive: true })
			await this.exec('pdfimages', ['-png', filePath, `${imagesDirResult.value}/img`])
		} catch {
			return []
		}

		return classifyExtractedImages(imageStore, 'images', ctx, this.registry, this.logger)
	}
}

// ============================================================================
// Shared image helpers
// ============================================================================

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|tiff?|bmp|svg)$/i

const IMAGE_MIME_MAP: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	svg: 'image/svg+xml',
	tif: 'image/tiff',
	tiff: 'image/tiff',
	bmp: 'image/bmp',
}

export function guessImageMime(filename: string): string {
	const ext = filename.split('.').pop()?.toLowerCase()
	return IMAGE_MIME_MAP[ext ?? ''] ?? 'image/png'
}

export async function classifyExtractedImages(
	imageStore: FileStore,
	relativePrefix: string,
	ctx: PreprocessorContext,
	registry: PreprocessorRegistry,
	logger: Logger,
): Promise<Array<{ relativePath: string; description: string }>> {
	const results: Array<{ relativePath: string; description: string }> = []

	const listResult = await imageStore.list('', { maxDepth: 3 })
	if (!listResult.ok) return results

	const imageFiles = listResult.value
		.filter(e => e.type === 'file' && IMAGE_EXT_RE.test(e.name))
		.sort((a, b) => a.name.localeCompare(b.name))
		.slice(0, MAX_IMAGES)

	for (const imgFile of imageFiles) {
		const imgPathResult = imageStore.realPath(imgFile.name)
		if (!imgPathResult.ok) continue

		const imgMime = guessImageMime(imgFile.name)
		let description = imgMime

		const classifier = registry.getForMimeType(imgMime)
		if (classifier) {
			const classifyResult = await classifier.process(imgPathResult.value, imgMime, {
				files: ctx.files.scoped(`${relativePrefix}/${imgFile.name}-meta`),
			})
			if (classifyResult.ok && classifyResult.value.extractedContent) {
				description = classifyResult.value.extractedContent
			}
		}

		results.push({ relativePath: `${relativePrefix}/${imgFile.name}`, description })
	}

	return results
}
