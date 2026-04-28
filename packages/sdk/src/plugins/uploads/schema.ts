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
import type { SessionId } from '../../core/sessions/schema.js'

// ============================================================================
// UploadId - Branded type
// ============================================================================

/** UploadId schema - validates any string and brands as UploadId. */
export const uploadIdSchema = z.string().brand('UploadId')

/** Branded UploadId type */
export type UploadId = z.infer<typeof uploadIdSchema>

/** Constructor for UploadId */
export const UploadId = (id: string): UploadId => id as UploadId

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
	/** Set when the upload is attached to a message via sendMessage */
	usedInMessageId?: string
}
