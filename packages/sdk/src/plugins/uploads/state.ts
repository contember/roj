import z4 from 'zod/v4'
import { createEventsFactory } from '~/core/events/types'
import { type LLMErrorType, llmErrorTypeSchema } from '~/core/llm/schema.js'
import type { UploadArtifact, UploadCapabilities } from './preprocessor.js'
import { uploadArtifactSchema, uploadCapabilitiesSchema, uploadIdSchema, type UploadSourceRef, uploadSourceRefSchema } from './schema.js'

export const uploadEvents = createEventsFactory({
	events: {
		attachment_uploaded: z4.object({
			uploadId: uploadIdSchema,
			filename: z4.string(),
			mimeType: z4.string(),
			size: z4.number(),
			status: z4.enum(['processing', 'ready', 'failed']),
			/** Set on `processing`; the log, unlike meta.json, is out of the agent's reach, so a re-run reads it from here. */
			source: uploadSourceRefSchema.optional(),
			/** Set on `processing`: which run this is, so the restart limit does not trust meta.json. */
			attempt: z4.number().int().positive().optional(),
			extractedContent: z4.string().optional(),
			derivedPaths: z4.array(z4.string()).optional(),
			artifacts: z4.array(uploadArtifactSchema).optional(),
			capabilities: uploadCapabilitiesSchema.optional(),
			error: z4.string().optional(),
		}),
		attachments_consumed: z4.object({
			agentId: z4.string(),
			uploadIds: z4.array(uploadIdSchema),
		}),
		attachment_deletion_completed: z4.object({
			uploadId: uploadIdSchema,
		}),
		/** The provider rejected the turn that carried these: they are left out, not consumed, and a note says so. */
		attachments_rejected: z4.object({
			agentId: z4.string(),
			uploadIds: z4.array(uploadIdSchema),
			errorType: llmErrorTypeSchema,
		}),
		/** A turn carrying the notes that these rejected uploads were left out was committed. */
		attachment_omissions_sent: z4.object({
			agentId: z4.string(),
			uploadIds: z4.array(uploadIdSchema),
		}),
	},
})

export type AttachmentUploadedEvent = (typeof uploadEvents)['Events']['attachment_uploaded']
export type AttachmentsConsumedEvent = (typeof uploadEvents)['Events']['attachments_consumed']
export type AttachmentDeletionCompletedEvent = (typeof uploadEvents)['Events']['attachment_deletion_completed']

/** A pending upload tracked in session state */
export interface PendingUpload {
	uploadId: string
	filename: string
	mimeType: string
	size: number
	status: 'ready' | 'failed'
	extractedContent?: string
	derivedPaths?: string[]
	artifacts?: UploadArtifact[]
	capabilities?: UploadCapabilities
	/** Set for a `blob` source: the original is in the host's blob store, not in the upload dir. */
	originalHeldByHost?: true
}

/** An upload left out of a turn the provider rejected. */
export interface RejectedUpload {
	uploadId: string
	filename: string
	mimeType: string
	errorType: LLMErrorType
	/** Set once a committed turn carried the note that the upload was left out. */
	noteSent?: true
}

/** An upload whose processing started and has not reached a terminal event. */
export interface ProcessingUpload {
	filename: string
	mimeType: string
	size: number
	source: UploadSourceRef
	/** The run the log last started; 1 for logs written before runs were counted. */
	attempt: number
}

/** Uploads plugin state slice — tracks pending (unconsumed) uploads */
export interface UploadsState {
	/** Uploads that have been uploaded but not yet consumed by an agent */
	pending: PendingUpload[]
	/**
	 * Uploads left out of a turn the provider rejected: not consumed, so they can be deleted, but no longer offered as
	 * attachable. The next turn tells the agent about those whose note is not sent yet.
	 */
	rejected: RejectedUpload[]
	/**
	 * Small terminal projection for uploads still visible to the user.
	 *
	 * Reconciliation against on-disk metadata keys off this plus
	 * `UploadMetadata.terminalEventPersisted`; it is idempotent, so no separate
	 * "awaiting materialization" projection is needed.
	 */
	terminal: Record<string, 'ready' | 'failed'>
	/** Uploads a restart may re-run. */
	processing: Record<string, ProcessingUpload>
	/**
	 * Host blobs each deletable upload references: its stored original and its artifacts' originals.
	 * Read from the log because the agent can rewrite meta.json, and a delete releases these.
	 */
	blobRefs: Record<string, string[]>
}
