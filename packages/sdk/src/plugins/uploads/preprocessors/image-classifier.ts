/**
 * Image Classifier Preprocessor
 *
 * Sends images to a vision-capable LLM for description.
 * Falls back to basic metadata if vision is not available.
 */

import type { ImageResizer } from '~/core/image/types.js'
import type { LLMProvider } from '~/core/llm/provider.js'
import { ModelId } from '~/core/llm/schema.js'
import type { Semaphore } from '~/lib/utils/concurrency.js'
import type { Result } from '~/lib/utils/result.js'
import { Err, Ok } from '~/lib/utils/result.js'
import type { FileSystem } from '~/platform/fs.js'
import type { Logger } from '../../../lib/logger/logger.js'
import {
	getPreprocessingSignal,
	preprocessingAbortError,
	throwIfPreprocessingAborted,
	type Preprocessor,
	type PreprocessorContext,
	type PreprocessorResult,
} from '../preprocessor.js'

/**
 * Anthropic vision API internally downsamples images to ~1568px long side.
 * Anything larger just wastes bandwidth and LLM tokens. For 1–2 sentence
 * descriptions, 1024px is more than enough detail.
 */
const CLASSIFY_MAX_DIMENSION = 1024
/** Hard cap to keep base64 payloads small (LLM still accepts up to 5MB). */
const CLASSIFY_MAX_FILE_SIZE_BYTES = 1 * 1024 * 1024

// ============================================================================
// Configuration
// ============================================================================

export interface ImageClassifierConfig {
	/** LLM provider for vision inference */
	llmProvider: LLMProvider
	/** Model to use for vision (should be vision-capable) */
	visionModel?: string
	/** Logger for debug output */
	logger: Logger
	/** FileSystem adapter (for checking + reading image files) */
	fs: FileSystem
	/**
	 * Optional resizer. When provided, classifier downscales images to
	 * ~1024px before sending to the vision LLM. Skipping this is fine for
	 * tests; in production it dramatically cuts payload size and token cost
	 * (brand PDFs embed 2000–3000px JPEGs the model would otherwise see at
	 * full resolution).
	 */
	imageResizer?: ImageResizer
	/** Whether to skip vision and just return metadata */
	skipVision?: boolean
	/**
	 * Optional semaphore to bound concurrent vision LLM calls. All callers
	 * sharing one instance compete for the same set of permits — useful when
	 * recursive preprocessors (ZIP → docs → images) would otherwise fan out
	 * into many simultaneous inferences.
	 */
	gate?: Semaphore
}

// ============================================================================
// Image Classifier
// ============================================================================

/**
 * Image classifier preprocessor.
 * Describes images using a vision-capable LLM.
 */
export class ImageClassifierPreprocessor implements Preprocessor {
	readonly name = 'image-classifier'
	readonly supportedMimeTypes = ['image/*']

	private readonly llmProvider: LLMProvider
	private readonly visionModel: ModelId
	private readonly logger: Logger
	private readonly fs: FileSystem
	private readonly imageResizer: ImageResizer | undefined
	private readonly skipVision: boolean
	private readonly gate: Semaphore | undefined

	constructor(config: ImageClassifierConfig) {
		this.llmProvider = config.llmProvider
		this.visionModel = config.visionModel ? ModelId(config.visionModel) : ModelId('anthropic/claude-haiku-4.5')
		this.logger = config.logger
		this.fs = config.fs
		this.imageResizer = config.imageResizer
		this.skipVision = config.skipVision ?? false
		this.gate = config.gate
	}

	async process(
		filePath: string,
		mimeType: string,
		ctx: PreprocessorContext,
	): Promise<Result<PreprocessorResult, Error>> {
		const totalStart = Date.now()
		const signal = getPreprocessingSignal(ctx)
		try {
			throwIfPreprocessingAborted(signal)
			// Check + stat image file
			if (!(await this.fs.exists(filePath))) {
				return Err(new Error(`Image file not found: ${filePath}`))
			}

			const size = (await this.fs.stat(filePath)).size
			const filename = filePath.split('/').pop() ?? 'image'

			// Skip vision if configured
			if (this.skipVision) {
				return Ok({
					extractedContent: `[Image: ${filename}, ${this.formatSize(size)}, ${mimeType}]`,
				})
			}

			// Try vision inference
			const inferenceStart = Date.now()
			const description = await this.describeImage(filePath, mimeType, ctx, signal)
			const inferenceDurationMs = Date.now() - inferenceStart

			if (description) {
				// Save description to file
				throwIfPreprocessingAborted(signal)
				const writeResult = await ctx.files.write('description.txt', description)

				this.logger.info('Image described successfully', {
					filename,
					mimeType,
					sizeBytes: size,
					descriptionLength: description.length,
					inferenceDurationMs,
					totalDurationMs: Date.now() - totalStart,
				})

				return Ok({
					extractedContent: `[Image: ${description}]`,
					derivedPaths: writeResult.ok ? ['description.txt'] : [],
				})
			}

			// Fallback to basic metadata
			this.logger.warn('Image description unavailable, falling back to metadata', {
				filename,
				mimeType,
				sizeBytes: size,
				inferenceDurationMs,
			})
			return Ok({
				extractedContent: `[Image: ${filename}, ${this.formatSize(size)}, ${mimeType}]`,
			})
		} catch (error) {
			if (signal.aborted) return Err(preprocessingAbortError(signal))
			this.logger.error(
				'Image classification failed',
				error instanceof Error ? error : undefined,
				{ filePath, durationMs: Date.now() - totalStart },
			)

			// Return basic info on error instead of failing
			const filename = filePath.split('/').pop() ?? 'image'
			return Ok({
				extractedContent: `[Image: ${filename} (description unavailable)]`,
			})
		}
	}

	/**
	 * Describe image using vision LLM.
	 * Returns null if vision is not available or fails.
	 */
	private async describeImage(
		filePath: string,
		mimeType: string,
		ctx: PreprocessorContext,
		signal: AbortSignal,
	): Promise<string | null> {
		try {
			const { url: imageUrl, cleanup } = await this.prepareImageUrl(filePath, mimeType, signal)

			try {
				const inferenceCall = () => {
					throwIfPreprocessingAborted(signal)
					return this.llmProvider.inference({
						model: this.visionModel,
						systemPrompt: 'You are an image description assistant. Describe images concisely in 1-2 sentences.',
						messages: [
							{
								role: 'user',
								content: [
									{
										type: 'text',
										text: 'Please describe this image concisely in 1-2 sentences. Focus on the main subject and any text visible.',
									},
									{
										type: 'image_url',
										imageUrl: { url: imageUrl },
									},
								],
							},
						],
						maxTokens: 200,
						temperature: 0.3,
					}, ctx.inferenceContext ? {
						...ctx.inferenceContext,
						signal,
					} : undefined)
				}

				const result = await (this.gate ? this.gate.run(inferenceCall, signal) : inferenceCall())

				if (result.ok && result.value.content) {
					return result.value.content.trim()
				}

				return null
			} finally {
				await cleanup()
			}
		} catch (error) {
			if (signal.aborted) throw preprocessingAbortError(signal)
			this.logger.warn('Vision inference failed', {
				error: error instanceof Error ? error.message : String(error),
			})
			return null
		}
	}

	/**
	 * Pre-resize the image for vision classification.
	 *
	 * Returns either a `data:` URL with the resized JPEG (when a resizer is
	 * available) or a `file://` URL fallback (LLM provider will resolve it via
	 * the global ImageProcessor, with its bigger maxDimension default).
	 *
	 * Cleanup removes any temp file produced by the resizer.
	 */
	private async prepareImageUrl(
		filePath: string,
		mimeType: string,
		signal: AbortSignal,
	): Promise<{ url: string; cleanup: () => Promise<void> }> {
		throwIfPreprocessingAborted(signal)
		if (!this.imageResizer) {
			return { url: `file://${filePath}`, cleanup: async () => {} }
		}

		let resizedTempFile: string | undefined
		try {
			const resized = await this.imageResizer.resize(filePath, mimeType, {
				maxDimension: CLASSIFY_MAX_DIMENSION,
				maxFileSizeBytes: CLASSIFY_MAX_FILE_SIZE_BYTES,
				signal,
			})
			resizedTempFile = resized.tempFile
			throwIfPreprocessingAborted(signal)
			const buffer = await this.fs.readFile(resized.path)
			throwIfPreprocessingAborted(signal)
			const base64 = buffer.toString('base64')
			return {
				url: `data:${resized.mimeType};base64,${base64}`,
				cleanup: async () => {
					if (resized.tempFile) {
						await this.fs.unlink(resized.tempFile).catch(() => {})
					}
				},
			}
		} catch (error) {
			if (resizedTempFile) {
				await this.fs.unlink(resizedTempFile).catch(() => {})
			}
			if (signal.aborted) throw preprocessingAbortError(signal)
			this.logger.warn('Pre-resize for classification failed, falling back to file:// URL', {
				filePath,
				error: error instanceof Error ? error.message : String(error),
			})
			return { url: `file://${filePath}`, cleanup: async () => {} }
		}
	}

	private formatSize(bytes: number): string {
		if (bytes < 1024) return `${bytes}B`
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
		return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
	}
}

/**
 * Create an image classifier preprocessor.
 */
export function createImageClassifierPreprocessor(
	config: ImageClassifierConfig,
): ImageClassifierPreprocessor {
	return new ImageClassifierPreprocessor(config)
}
