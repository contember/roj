/**
 * Image Classifier Preprocessor
 *
 * Sends images to a vision-capable LLM for description.
 * Falls back to basic metadata if vision is not available.
 */

import type { LLMProvider } from '~/core/llm/provider.js'
import { ModelId } from '~/core/llm/schema.js'
import type { Result } from '~/lib/utils/result.js'
import { Err, Ok } from '~/lib/utils/result.js'
import type { FileSystem } from '~/platform/fs.js'
import type { Logger } from '../../../lib/logger/logger.js'
import type { Preprocessor, PreprocessorContext, PreprocessorResult } from '../preprocessor.js'

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
	/** Whether to skip vision and just return metadata */
	skipVision?: boolean
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
	private readonly skipVision: boolean

	constructor(config: ImageClassifierConfig) {
		this.llmProvider = config.llmProvider
		this.visionModel = config.visionModel ? ModelId(config.visionModel) : ModelId('anthropic/claude-haiku-4.5')
		this.logger = config.logger
		this.fs = config.fs
		this.skipVision = config.skipVision ?? false
	}

	async process(
		filePath: string,
		mimeType: string,
		ctx: PreprocessorContext,
	): Promise<Result<PreprocessorResult, Error>> {
		try {
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
			const description = await this.describeImage(filePath, mimeType)

			if (description) {
				// Save description to file
				const writeResult = await ctx.files.write('description.txt', description)

				this.logger.debug('Image described successfully', {
					filename,
					descriptionLength: description.length,
				})

				return Ok({
					extractedContent: `[Image: ${description}]`,
					derivedPaths: writeResult.ok ? ['description.txt'] : [],
				})
			}

			// Fallback to basic metadata
			return Ok({
				extractedContent: `[Image: ${filename}, ${this.formatSize(size)}, ${mimeType}]`,
			})
		} catch (error) {
			this.logger.error(
				'Image classification failed',
				error instanceof Error ? error : undefined,
				{ filePath },
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
	): Promise<string | null> {
		try {
			// Use file:// URL - resolved to base64 lazily in LLM provider
			const result = await this.llmProvider.inference({
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
								imageUrl: { url: `file://${filePath}` },
							},
						],
					},
				],
				maxTokens: 200,
				temperature: 0.3,
			})

			if (result.ok && result.value.content) {
				return result.value.content.trim()
			}

			return null
		} catch (error) {
			this.logger.warn('Vision inference failed', {
				error: error instanceof Error ? error.message : String(error),
			})
			return null
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
