/**
 * Preprocessor - Interface for file upload preprocessing
 *
 * Preprocessors extract content from uploaded files to make them
 * accessible to LLMs. Examples include:
 * - Image description via vision LLM
 * - PDF text extraction
 * - Document conversion
 */

import type { FileStore } from '~/core/file-store/types.js'
import type { Result } from '~/lib/utils/result.js'

// ============================================================================
// Preprocessor Context
// ============================================================================

/**
 * Context provided to preprocessors during file processing.
 */
export interface PreprocessorContext {
	/** FileStore scoped to upload directory for writing derived files */
	files: FileStore
}

// ============================================================================
// Preprocessor Result
// ============================================================================

/**
 * Result of preprocessing a file.
 */
export interface PreprocessorResult {
	/** Extracted text content for LLM consumption */
	extractedContent?: string
	/** Paths to derived files (e.g., extracted images from PDF) */
	derivedPaths?: string[]
}

// ============================================================================
// Preprocessor Interface
// ============================================================================

/**
 * Interface for file preprocessors.
 * Each preprocessor handles specific MIME types.
 */
export interface Preprocessor {
	/** Name of the preprocessor for logging */
	name: string
	/** MIME types this preprocessor can handle (supports wildcards like "image/*") */
	supportedMimeTypes: string[]
	/**
	 * Process a file and extract content.
	 *
	 * @param filePath - Absolute path to the uploaded file
	 * @param mimeType - MIME type of the file
	 * @param ctx - Context with artifact store for writing derived files
	 * @returns Result with extracted content or error
	 */
	process(
		filePath: string,
		mimeType: string,
		ctx: PreprocessorContext,
	): Promise<Result<PreprocessorResult, Error>>
}

// ============================================================================
// Preprocessor Registry
// ============================================================================

/**
 * Registry for file preprocessors.
 * Manages preprocessor registration and lookup by MIME type.
 */
export class PreprocessorRegistry {
	private readonly processors: Preprocessor[] = []

	/**
	 * Register a preprocessor.
	 */
	register(processor: Preprocessor): void {
		this.processors.push(processor)
	}

	/**
	 * Get a preprocessor for the given MIME type.
	 * Returns null if no preprocessor supports this type.
	 *
	 * @param mimeType - MIME type to find a preprocessor for
	 * @returns The first matching preprocessor or null
	 */
	getForMimeType(mimeType: string): Preprocessor | null {
		return (
			this.processors.find((p) =>
				p.supportedMimeTypes.some((t) =>
					t.endsWith('/*')
						? mimeType.startsWith(t.slice(0, -1))
						: t === mimeType
				)
			) ?? null
		)
	}

	/**
	 * Get all registered preprocessors.
	 */
	getAll(): readonly Preprocessor[] {
		return this.processors
	}
}
