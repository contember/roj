/**
 * Markitdown Preprocessor
 *
 * Converts documents to markdown using Microsoft's markitdown CLI.
 * Supports DOCX, XLSX, PPTX, HTML, CSV, JSON, XML, EPUB, RTF, ODT.
 *
 * PDFs are handled by `PdfPreprocessor` instead — markitdown's PDF backend
 * (pdfminer.six) is ~20× slower than pdftotext for no real gain on the
 * mostly-unstructured PDFs we see in practice.
 *
 * Image extraction:
 * - DOCX/ODT/EPUB: uses pandoc --extract-media (runs in parallel with markitdown)
 *
 * Extracted images are classified via the image classifier preprocessor.
 * Full content is written to disk; extractedContent contains a structured manifest.
 */

import { dirname } from 'node:path'
import { mapWithConcurrency } from '~/lib/utils/concurrency.js'
import type { Result } from '~/lib/utils/result.js'
import { Err, Ok } from '~/lib/utils/result.js'
import type { FileSystem } from '~/platform/fs.js'
import type { ProcessRunner } from '~/platform/process.js'
import type { FileStore } from '../../../core/file-store/types.js'
import type { Logger } from '../../../lib/logger/logger.js'
import type { Preprocessor, PreprocessorContext, PreprocessorRegistry, PreprocessorResult } from '../preprocessor.js'

const MAX_IMAGES = 20
const IMAGE_CLASSIFY_CONCURRENCY = 10

/**
 * Density filter for extracted images. Bytes-per-pixel ratio below this
 * threshold typically means the image is an alpha mask, overlay layer, or
 * essentially-empty region — not worth a vision call.
 *
 * Empirical reference points:
 * - Dense photo JPEG: 0.3–1.0 B/px
 * - Logo / icon PNG: 0.1–0.5 B/px
 * - Brand PDF layer mask: <0.005 B/px
 */
export const MIN_IMAGE_DENSITY_BYTES_PER_PX = 0.05
export const MIN_IMAGE_PIXELS = 50 * 50

// markitdown converts a text-only document; even large files finish in seconds.
const MARKITDOWN_TIMEOUT_MS = 60_000
// Image extractors (pandoc --extract-media) scale with image count
// and resolution. Real-world large docs can take 60–90s. Upload preprocessing
// is async/background, so allow generous headroom.
const IMAGE_EXTRACT_TIMEOUT_MS = 5 * 60_000

function makeExec(processRunner: ProcessRunner) {
	return (cmd: string, args: string[], timeoutMs: number = MARKITDOWN_TIMEOUT_MS) =>
		processRunner.execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 50 * 1024 * 1024 })
}

/** MIME types where markitdown converts to markdown (non-ZIP, non-image, non-PDF) */
const SUPPORTED_MIME_TYPES = [
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
	private readonly processRunner: ProcessRunner
	private readonly exec: (cmd: string, args: string[], timeoutMs?: number) => Promise<{ stdout: string; stderr: string }>

	constructor(config: MarkitdownPreprocessorConfig) {
		this.registry = config.registry
		this.logger = config.logger
		this.fs = config.fs
		this.processRunner = config.process
		this.exec = makeExec(config.process)
	}

	async process(
		filePath: string,
		mimeType: string,
		ctx: PreprocessorContext,
	): Promise<Result<PreprocessorResult, Error>> {
		const totalStart = Date.now()

		this.logger.info('Markitdown processing started', { filePath, mimeType })

		const contentPathResult = ctx.files.realPath('content.md')
		if (!contentPathResult.ok) {
			return Err(new Error('Failed to resolve output path'))
		}
		await this.fs.mkdir(dirname(contentPathResult.value), { recursive: true })

		// Race markitdown text conversion and image extraction — they're
		// independent, so there's no reason to serialize them. For documents
		// where pandoc extraction isn't applicable, the image task resolves
		// immediately.
		const markdownTask = this.runMarkitdown(filePath, mimeType, contentPathResult.value)
		const imageTask = PANDOC_EXTRACT_MIMES.has(mimeType)
			? this.extractImagesWithPandoc(filePath, mimeType, ctx)
			: Promise.resolve<Array<{ relativePath: string; description: string }>>([])

		const [markdownResult, images] = await Promise.all([markdownTask, imageTask])

		if (!markdownResult.ok) return markdownResult

		const markdown = markdownResult.value

		const derivedPaths: string[] = ['content.md']
		const imageEntries: string[] = []
		for (const img of images) {
			derivedPaths.push(img.relativePath)
			imageEntries.push(`- ${img.relativePath} — ${img.description}`)
		}

		const manifestLines: string[] = ['Extracted files:']
		manifestLines.push(`- content.md (markdown, ${markdown.length} chars)`)
		manifestLines.push(...imageEntries)

		this.logger.info('Markitdown processing complete', {
			filePath,
			mimeType,
			contentLength: markdown.length,
			imagesExtracted: imageEntries.length,
			totalDurationMs: Date.now() - totalStart,
		})

		return Ok({
			extractedContent: manifestLines.join('\n'),
			derivedPaths,
		})
	}

	private async runMarkitdown(
		filePath: string,
		mimeType: string,
		outputPath: string,
	): Promise<Result<string, Error>> {
		const markitdownStart = Date.now()
		try {
			await this.exec('markitdown', [filePath, '-o', outputPath])
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			this.logger.error(
				'markitdown CLI failed',
				error instanceof Error ? error : undefined,
				{ filePath, mimeType, durationMs: Date.now() - markitdownStart },
			)
			if (message.includes('ENOENT')) {
				return Err(new Error('markitdown not found. Install with: pip install "markitdown[all]"'))
			}
			return Err(new Error(`markitdown failed: ${message}`))
		}

		let markdown = ''
		try {
			markdown = await this.fs.readFile(outputPath, 'utf-8')
		} catch {
			// Output missing — markitdown completed but produced nothing.
		}

		this.logger.info('Markitdown conversion complete', {
			filePath,
			mimeType,
			durationMs: Date.now() - markitdownStart,
			contentLength: markdown.length,
		})

		return Ok(markdown)
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

		const pandocStart = Date.now()
		let extractSucceeded = true
		try {
			await this.exec(
				'pandoc',
				['-f', format, '-t', 'gfm', filePath, '-o', '/dev/null', `--extract-media=${mediaDirResult.value}`],
				IMAGE_EXTRACT_TIMEOUT_MS,
			)
		} catch (error) {
			extractSucceeded = false
			this.logger.warn('pandoc --extract-media failed (will classify any partial output)', {
				filePath,
				durationMs: Date.now() - pandocStart,
				error: error instanceof Error ? error.message : String(error),
			})
		}
		if (extractSucceeded) {
			this.logger.info('pandoc --extract-media complete', {
				filePath,
				format,
				durationMs: Date.now() - pandocStart,
			})
		}

		const classifyStart = Date.now()
		const images = await classifyExtractedImages(mediaStore, 'media', ctx, this.registry, this.logger, this.fs, this.processRunner)
		this.logger.info('Image classification complete', {
			source: 'pandoc',
			count: images.length,
			partial: !extractSucceeded,
			durationMs: Date.now() - classifyStart,
		})
		return images
	}
}

// ============================================================================
// Shared image helpers
// ============================================================================

/**
 * Recognized by Anthropic vision API. Other pdfimages outputs (pbm, ppm,
 * jb2e, jp2) are ignored — they'd require local conversion before being
 * useful for classification.
 */
export const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|tiff?|bmp|svg)$/i

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

/**
 * Reject images that are unlikely to carry useful visual information.
 *
 * `bytesPerPixel` filters out alpha masks, sparse overlays, and essentially-
 * empty pages — brand PDFs typically emit a real photo (~1 B/px) plus a
 * matching transparency/overlay layer at the same dimensions but a fraction
 * of a percent of the size (<0.005 B/px).
 *
 * The minimum pixel count protects against tiny icons whose density alone
 * doesn't disqualify them.
 */
export function shouldClassifyImage(meta: { width: number; height: number; sizeBytes: number }): boolean {
	const pixels = meta.width * meta.height
	if (pixels < MIN_IMAGE_PIXELS) return false
	const density = meta.sizeBytes / pixels
	return density >= MIN_IMAGE_DENSITY_BYTES_PER_PX
}

/**
 * Read image dimensions via vipsheader. Returns null when the tool isn't
 * available or output is unparseable — caller should treat that as
 * "include without filtering".
 */
export async function getImageDimensions(
	filePath: string,
	processRunner: ProcessRunner,
): Promise<{ width: number; height: number } | null> {
	try {
		const { stdout } = await processRunner.execFile(
			'vipsheader',
			['-f', 'width', '-f', 'height', filePath],
			{ timeout: 10_000 },
		)
		const lines = stdout.trim().split('\n')
		if (lines.length < 2) return null
		const width = parseInt(lines[0], 10)
		const height = parseInt(lines[1], 10)
		if (!Number.isFinite(width) || !Number.isFinite(height)) return null
		return { width, height }
	} catch {
		return null
	}
}

export async function classifyExtractedImages(
	imageStore: FileStore,
	relativePrefix: string,
	ctx: PreprocessorContext,
	registry: PreprocessorRegistry,
	logger: Logger,
	fs: FileSystem,
	processRunner: ProcessRunner,
): Promise<Array<{ relativePath: string; description: string }>> {
	const listResult = await imageStore.list('', { maxDepth: 3 })
	if (!listResult.ok) return []

	const candidates = listResult.value.filter(e => e.type === 'file' && IMAGE_EXT_RE.test(e.name))

	// Stat + density filter, then keep the top MAX_IMAGES by file size.
	const inspected = await mapWithConcurrency(candidates, 8, async (entry) => {
		const pathResult = imageStore.realPath(entry.name)
		if (!pathResult.ok) return null

		let sizeBytes = 0
		try {
			sizeBytes = (await fs.stat(pathResult.value)).size
		} catch {
			return null
		}

		const dims = await getImageDimensions(pathResult.value, processRunner)
		if (!dims) {
			// Unknown dims — include but warn; better to classify than silently drop.
			return { name: entry.name, sizeBytes, width: 0, height: 0, kept: true }
		}

		const kept = shouldClassifyImage({ width: dims.width, height: dims.height, sizeBytes })
		return { name: entry.name, sizeBytes, width: dims.width, height: dims.height, kept }
	})

	const filtered = inspected
		.filter((r): r is NonNullable<typeof r> => r !== null && r.kept)
		.sort((a, b) => b.sizeBytes - a.sizeBytes)
		.slice(0, MAX_IMAGES)

	const droppedCount = inspected.filter(r => r !== null && !r.kept).length
	if (droppedCount > 0 || inspected.length > MAX_IMAGES) {
		logger.info('Image filter applied', {
			source: relativePrefix,
			candidates: candidates.length,
			passedDensityFilter: candidates.length - droppedCount,
			selected: filtered.length,
			droppedByDensity: droppedCount,
		})
	}

	const settled = await mapWithConcurrency(filtered, IMAGE_CLASSIFY_CONCURRENCY, async (imgFile) => {
		const imgPathResult = imageStore.realPath(imgFile.name)
		if (!imgPathResult.ok) return null

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

		return { relativePath: `${relativePrefix}/${imgFile.name}`, description }
	})

	return settled.filter((r): r is { relativePath: string; description: string } => r !== null)
}
