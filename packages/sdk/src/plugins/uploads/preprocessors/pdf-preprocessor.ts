/**
 * PDF Preprocessor
 *
 * Dedicated PDF pipeline:
 *
 * 1. Text extraction via `pdftotext` (poppler-utils, C++) — ~1 s for a
 *    3 MB PDF. Replaces markitdown/pdfminer.six (~22 s for the same file)
 *    because PDFs in practice don't carry the rich markdown structure
 *    that justifies the slower backend.
 *
 * 2. Image extraction via `pdfimages -all` — keeps the original embedded
 *    format (JPEG stays JPEG) instead of re-encoding everything to PNG
 *    (~10× faster, much smaller files).
 *
 * 3. Text and image extraction run in parallel.
 *
 * 4. Images stream into the classifier as soon as `pdfimages` writes them
 *    to disk — the classifier doesn't wait for the whole extraction to
 *    finish. A density filter (bytes/pixel) drops alpha masks and overlay
 *    layers before the vision call.
 */

import { sleep } from '../../../lib/utils/sleep.js'
import { dirname } from 'node:path'
import type { Result } from '~/lib/utils/result.js'
import { Err, Ok } from '~/lib/utils/result.js'
import type { FileSystem } from '~/platform/fs.js'
import type { ProcessRunner } from '~/platform/process.js'
import type { Logger } from '../../../lib/logger/logger.js'
import type { Preprocessor, PreprocessorContext, PreprocessorRegistry, PreprocessorResult } from '../preprocessor.js'
import {
	getImageDimensions,
	guessImageMime,
	IMAGE_EXT_RE,
	MIN_IMAGE_DENSITY_BYTES_PER_PX,
	MIN_IMAGE_PIXELS,
	shouldClassifyImage,
} from './markitdown-preprocessor.js'

const PDFTOTEXT_TIMEOUT_MS = 60_000
const PDFIMAGES_TIMEOUT_MS = 5 * 60_000

const MAX_IMAGES = 20
const CLASSIFY_CONCURRENCY = 10
const STREAM_POLL_INTERVAL_MS = 250

const SUPPORTED_MIME_TYPES = ['application/pdf']

export interface PdfPreprocessorConfig {
	registry: PreprocessorRegistry
	logger: Logger
	fs: FileSystem
	process: ProcessRunner
}

export class PdfPreprocessor implements Preprocessor {
	readonly name = 'pdf'
	readonly supportedMimeTypes = SUPPORTED_MIME_TYPES

	private readonly registry: PreprocessorRegistry
	private readonly logger: Logger
	private readonly fs: FileSystem
	private readonly processRunner: ProcessRunner

	constructor(config: PdfPreprocessorConfig) {
		this.registry = config.registry
		this.logger = config.logger
		this.fs = config.fs
		this.processRunner = config.process
	}

	async process(
		filePath: string,
		mimeType: string,
		ctx: PreprocessorContext,
	): Promise<Result<PreprocessorResult, Error>> {
		const totalStart = Date.now()
		this.logger.info('PDF processing started', { filePath })

		const contentPathResult = ctx.files.realPath('content.md')
		if (!contentPathResult.ok) return Err(new Error('Failed to resolve content output path'))

		const imagesDirResult = ctx.files.scoped('images').realPath('')
		if (!imagesDirResult.ok) return Err(new Error('Failed to resolve images output path'))

		await this.fs.mkdir(dirname(contentPathResult.value), { recursive: true })
		await this.fs.mkdir(imagesDirResult.value, { recursive: true })

		// Run text extraction and image extraction (with streaming classification)
		// in parallel. They share no state and don't block each other.
		const [textResult, images] = await Promise.all([
			this.extractText(filePath, contentPathResult.value),
			this.extractAndClassifyImages(filePath, imagesDirResult.value, ctx),
		])

		const markdown = textResult.ok ? textResult.value : ''

		const derivedPaths: string[] = ['content.md']
		const imageEntries: string[] = []
		for (const img of images) {
			derivedPaths.push(img.relativePath)
			imageEntries.push(`- ${img.relativePath} — ${img.description}`)
		}

		const manifestLines: string[] = ['Extracted files:']
		manifestLines.push(`- content.md (text, ${markdown.length} chars)`)
		manifestLines.push(...imageEntries)

		this.logger.info('PDF processing complete', {
			filePath,
			contentLength: markdown.length,
			imagesClassified: imageEntries.length,
			totalDurationMs: Date.now() - totalStart,
		})

		return Ok({
			extractedContent: manifestLines.join('\n'),
			derivedPaths,
		})
	}

	/**
	 * Extract plain text via pdftotext. Writes to content.md verbatim — no
	 * markdown structure to preserve, but the file extension stays .md for
	 * consistency with the markitdown pipeline (downstream consumers expect
	 * "content.md" in the upload directory).
	 *
	 * `-layout` preserves the original visual layout (columns, tables),
	 * which is what users typically expect when looking at PDFs.
	 */
	private async extractText(filePath: string, outputPath: string): Promise<Result<string, Error>> {
		const start = Date.now()
		try {
			await this.processRunner.execFile(
				'pdftotext',
				['-layout', filePath, outputPath],
				{ timeout: PDFTOTEXT_TIMEOUT_MS, maxBuffer: 50 * 1024 * 1024 },
			)
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			this.logger.warn('pdftotext failed', { filePath, durationMs: Date.now() - start, error: message })
			return Err(new Error(`pdftotext failed: ${message}`))
		}

		let text = ''
		try {
			text = await this.fs.readFile(outputPath, 'utf-8')
		} catch {
			// File missing — pdftotext succeeded but produced no output.
		}

		this.logger.info('pdftotext complete', {
			filePath,
			durationMs: Date.now() - start,
			contentLength: text.length,
		})

		return Ok(text)
	}

	/**
	 * Extract images via pdfimages and classify them as they appear on disk.
	 *
	 * pdfimages writes files atomically per image (open temp, write, rename
	 * to final name), so polling `readdir` is safe — we either see a name or
	 * we don't, never a half-written file.
	 *
	 * Streaming overlaps the extraction tail with the first classification
	 * batches. Hard cap of MAX_IMAGES applies across the *filtered* set: as
	 * soon as MAX_IMAGES images have passed the density filter, further
	 * candidates are stat-checked but not classified.
	 *
	 * `-all` keeps the embedded format (JPEG, JBIG2, JP2). We only classify
	 * those Anthropic vision accepts (PNG/JPEG/GIF/WebP); other formats are
	 * extracted to disk for reference but skipped at the classification step.
	 */
	private async extractAndClassifyImages(
		filePath: string,
		imagesDir: string,
		ctx: PreprocessorContext,
	): Promise<Array<{ relativePath: string; description: string }>> {
		const extractStart = Date.now()
		const seen = new Set<string>()
		const acceptedQueue: Array<{ name: string; sizeBytes: number; width: number; height: number }> = []
		const classifyPromises: Array<Promise<{ relativePath: string; description: string } | null>> = []
		let stopAccepting = false
		let droppedByDensity = 0
		let skippedUnsupportedExt = 0

		// Active classification gate — caps in-flight vision calls.
		let active = 0
		const waiters: Array<() => void> = []
		const acquire = () => new Promise<void>(resolve => {
			if (active < CLASSIFY_CONCURRENCY) { active++; resolve() }
			else waiters.push(() => { active++; resolve() })
		})
		const release = () => {
			active--
			const next = waiters.shift()
			if (next) next()
		}

		const classifyOne = async (name: string): Promise<{ relativePath: string; description: string } | null> => {
			await acquire()
			try {
				const mime = guessImageMime(name)
				const fullPath = `${imagesDir}/${name}`
				const imageStore = ctx.files.scoped('images')
				let description = mime

				const classifier = this.registry.getForMimeType(mime)
				if (classifier) {
					const result = await classifier.process(fullPath, mime, {
						files: ctx.files.scoped(`images/${name}-meta`),
					})
					if (result.ok && result.value.extractedContent) {
						description = result.value.extractedContent
					}
				}

				return { relativePath: `images/${name}`, description }
			} finally {
				release()
			}
		}

		const inspectAndMaybeClassify = async (name: string) => {
			if (seen.has(name) || stopAccepting) return
			seen.add(name)

			if (!IMAGE_EXT_RE.test(name)) {
				skippedUnsupportedExt++
				return
			}

			const fullPath = `${imagesDir}/${name}`
			let sizeBytes = 0
			try {
				sizeBytes = (await this.fs.stat(fullPath)).size
			} catch {
				return
			}

			const dims = await getImageDimensions(fullPath, this.processRunner)
			const hasDims = dims !== null
			const passesFilter = hasDims
				? shouldClassifyImage({ width: dims.width, height: dims.height, sizeBytes })
				: sizeBytes >= MIN_IMAGE_PIXELS * MIN_IMAGE_DENSITY_BYTES_PER_PX // fall back to absolute byte floor

			if (!passesFilter) {
				droppedByDensity++
				return
			}

			acceptedQueue.push({
				name,
				sizeBytes,
				width: dims?.width ?? 0,
				height: dims?.height ?? 0,
			})

			if (acceptedQueue.length >= MAX_IMAGES) {
				stopAccepting = true
			}

			classifyPromises.push(classifyOne(name))
		}

		// Run pdfimages and a parallel poll loop. The poll calls readdir
		// periodically and dispatches `inspectAndMaybeClassify` for newly
		// appeared files; doing it this way avoids fs.watch quirks (some
		// container filesystems don't deliver events).
		const pdfimagesPromise = this.processRunner.execFile(
			'pdfimages',
			['-all', filePath, `${imagesDir}/img`],
			{ timeout: PDFIMAGES_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
		).then(() => true).catch((error) => {
			this.logger.warn('pdfimages failed (will classify any partial output)', {
				filePath,
				durationMs: Date.now() - extractStart,
				error: error instanceof Error ? error.message : String(error),
			})
			return false
		})

		let extractionDone = false
		const poll = async () => {
			while (!extractionDone) {
				await this.scanAndDispatch(imagesDir, inspectAndMaybeClassify)
				await sleep(STREAM_POLL_INTERVAL_MS)
			}
			// Final sweep — pick up anything that landed between the last poll
			// and pdfimages exiting.
			await this.scanAndDispatch(imagesDir, inspectAndMaybeClassify)
		}

		const pollPromise = poll()

		const extractSucceeded = await pdfimagesPromise
		extractionDone = true
		await pollPromise

		this.logger.info(extractSucceeded ? 'pdfimages complete' : 'pdfimages failed (partial)', {
			filePath,
			durationMs: Date.now() - extractStart,
			filesEmitted: seen.size,
			passedFilter: acceptedQueue.length,
			droppedByDensity,
			skippedUnsupportedExt,
		})

		const classifyStart = Date.now()
		const settled = await Promise.all(classifyPromises)
		const images = settled.filter((r): r is { relativePath: string; description: string } => r !== null)

		this.logger.info('PDF image classification complete', {
			filePath,
			count: images.length,
			durationMs: Date.now() - classifyStart,
		})

		return images
	}

	private async scanAndDispatch(
		dir: string,
		handle: (name: string) => Promise<void>,
	): Promise<void> {
		let entries: string[]
		try {
			entries = await this.fs.readdir(dir)
		} catch {
			return
		}
		// Fire dispatches in parallel — `inspectAndMaybeClassify` is internally
		// idempotent for already-seen names.
		await Promise.all(entries.map(handle))
	}
}
