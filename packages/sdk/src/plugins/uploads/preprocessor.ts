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
import type { InferenceContext } from '~/core/llm/provider.js'
import type { ArchiveBudget } from '~/lib/archive/index.js'
import { Err, Ok, type Result } from '~/lib/utils/result.js'
import type { UploadSource } from './source.js'

// ============================================================================
// Preprocessor Context
// ============================================================================

/**
 * Context provided to preprocessors during file processing.
 */
export interface PreprocessorContext {
	/** FileStore scoped to upload directory for writing derived files */
	files: FileStore
	uploadId: string
	sessionId: string
	/** Name of the file being processed; a nested preprocessor gets the nested file's name. */
	filename: string
	/** 1 on the first run; increments when processing re-runs after a restart. */
	attempt: number
	/**
	 * Cancels subprocesses, inference calls, and derived-file generation.
	 * Implementations should settle promptly; the host stops awaiting after a bounded grace period.
	 */
	signal?: AbortSignal
	/** Optional metadata required to pass cancellation through LLM providers. */
	inferenceContext?: Omit<InferenceContext, 'signal'>
	/** Shared extraction budget for all ZIPs nested within one upload. */
	archiveBudget?: ArchiveBudget
}

const NEVER_ABORTED_SIGNAL = new AbortController().signal

export function getPreprocessingSignal(ctx: PreprocessorContext): AbortSignal {
	return ctx.signal ?? NEVER_ABORTED_SIGNAL
}

export function preprocessingAbortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error('Processing cancelled')
}

export function throwIfPreprocessingAborted(signal: AbortSignal): void {
	if (signal.aborted) throw preprocessingAbortError(signal)
}

/** The local file a process-based preprocessor hands to its tools; a host without one gets an Err. */
export function requireLocalPath(source: UploadSource, preprocessorName: string): Result<string, Error> {
	return source.localPath ? Ok(source.localPath) : Err(new Error(`The ${preprocessorName} preprocessor requires a local file`))
}

// ============================================================================
// Preprocessor Result
// ============================================================================

export interface UploadArtifact {
	/** Relative to the upload dir. A file at this path exists in the session file store and is what the agent reads (text, or a preview image). */
	path: string
	mimeType: string
	size: number
	/** Full-fidelity bytes the host keeps elsewhere (e.g. the original of a preview). */
	blobRef?: string
	description?: string
}

export interface UploadCapabilities {
	text?: boolean
	embeddedImages?: boolean
	captions?: boolean
	ocr?: boolean
	truncated?: boolean
	pagesProcessed?: number
	/** Stored, content not analysed. */
	assetOnly?: boolean
}

/**
 * Result of preprocessing a file.
 */
export interface PreprocessorResult {
	/** Extracted text content for LLM consumption */
	extractedContent?: string
	/** Paths to derived files (e.g., extracted images from PDF) */
	derivedPaths?: string[]
	artifacts?: UploadArtifact[]
	capabilities?: UploadCapabilities
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
	readonly name: string
	/** MIME types this preprocessor can handle (supports wildcards like "image/*") */
	readonly supportedMimeTypes: readonly string[]
	/**
	 * Process a file and extract content.
	 *
	 * @param source - The uploaded bytes; `source.localPath` is set only when they are a local file
	 * @param mimeType - MIME type of the file
	 * @param ctx - Context with artifact store for writing derived files
	 * @returns Result with extracted content or error
	 */
	process(
		source: UploadSource,
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
