/**
 * Upload domain types and schemas
 *
 * Contains all types related to uploads:
 * - Branded ID type and constructor
 * - Upload metadata types
 * - Zod schemas for validation
 */

import { uuidv7 } from 'uuidv7'
import z from 'zod/v4'
import { type DomainError, ValidationErrors } from '~/core/errors.js'
import { Err, Ok, type Result } from '~/lib/utils/result.js'
import type { SessionId } from '../../core/sessions/schema.js'

// ============================================================================
// UploadId - Branded type
// ============================================================================

/**
 * Characters an upload id may contain.
 *
 * Twin of `SESSION_ID_PATTERN`: the id is interpolated straight into filesystem
 * paths (`sessions/<sessionId>/uploads/<uploadId>`) and into the basePath handed to
 * the agent, and FileStore containment is lexical and rooted at the data dir, so a
 * `..` segment reaches a sibling session rather than escaping outright. Generated
 * ids are UUIDv7, which fits.
 */
export const UPLOAD_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** True when the value is safe to interpolate into a path. */
export const isValidUploadId = (id: string): boolean => UPLOAD_ID_PATTERN.test(id)

/** UploadId schema - validates the id shape and brands as UploadId. */
export const uploadIdSchema = z.string().regex(UPLOAD_ID_PATTERN, 'Invalid upload id').brand('UploadId')

/** Branded UploadId type */
export type UploadId = z.infer<typeof uploadIdSchema>

/**
 * Unchecked brand — only for ids already known to match `UPLOAD_ID_PATTERN`.
 *
 * It does not validate, so it must never see untrusted input. Use `parseUploadId`
 * at a boundary that is not a method input, and `uploadIdSchema` at one that is.
 */
export const UploadId = (id: string): UploadId => id as UploadId

/** Checked UploadId constructor — the form to use on untrusted input. */
export const parseUploadId = (value: string): Result<UploadId, DomainError> =>
	isValidUploadId(value) ? Ok(UploadId(value)) : Err(ValidationErrors.invalid('Invalid upload id'))

/** Generate a new UploadId (UUIDv7) */
export const generateUploadId = (): UploadId => UploadId(uuidv7())

// ============================================================================
// UploadId - Zod schemas
// ============================================================================

// ============================================================================
// Upload types
// ============================================================================

/**
 * Information about an uploaded file stored on disk.
 */
export interface UploadedFile {
	/** Relative path within upload directory */
	filename: string
	/** Absolute path to the file */
	path: string
	/** File size in bytes */
	size: number
	/** MIME type of the file */
	mimeType: string
}

/**
 * Attachment included with a mailbox message.
 * Represents a user-uploaded file that has been processed.
 */
export interface MessageAttachment {
	/** Unique identifier for this upload */
	uploadId: UploadId
	/** Original filename as uploaded by user */
	filename: string
	/** MIME type of the original file */
	mimeType: string
	/** File size in bytes */
	size: number
	/** Absolute path to the original file */
	path: string
	/** Text content extracted by pre-processor (image description, PDF text, etc.) */
	extractedContent?: string
	/** Paths to derived files (extracted images, converted documents, etc.) */
	derivedPaths?: string[]
}

/**
 * Metadata for an upload stored on disk.
 * Used to track upload status and associate with messages later.
 */
export interface UploadMetadata {
	uploadId: UploadId
	sessionId: SessionId
	filename: string
	mimeType: string
	size: number
	path: string
	status: 'processing' | 'ready' | 'failed' | 'deleted'
	extractedContent?: string
	derivedPaths?: string[]
	createdAt: number
	completedAt?: number
	error?: string
	/** Set only after the terminal event is durable. */
	terminalEventPersisted?: boolean
	/** Set when the upload is attached to a message via sendMessage */
	usedInMessageId?: string
}
