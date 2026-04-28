import z4 from 'zod/v4'
import { createEventsFactory } from '~/core/events/types'
import { uploadIdSchema } from './schema'

export const uploadEvents = createEventsFactory({
	events: {
		attachment_uploaded: z4.object({
			uploadId: uploadIdSchema,
			filename: z4.string(),
			mimeType: z4.string(),
			size: z4.number(),
			status: z4.enum(['ready', 'failed']),
			extractedContent: z4.string().optional(),
			derivedPaths: z4.array(z4.string()).optional(),
			error: z4.string().optional(),
		}),
		attachments_consumed: z4.object({
			agentId: z4.string(),
			uploadIds: z4.array(uploadIdSchema),
		}),
	},
})

export type AttachmentUploadedEvent = (typeof uploadEvents)['Events']['attachment_uploaded']
export type AttachmentsConsumedEvent = (typeof uploadEvents)['Events']['attachments_consumed']

/** A pending upload tracked in session state */
export interface PendingUpload {
	uploadId: string
	filename: string
	mimeType: string
	size: number
	status: 'ready' | 'failed'
	extractedContent?: string
	derivedPaths?: string[]
}

/** Uploads plugin state slice — tracks pending (unconsumed) uploads */
export interface UploadsState {
	/** Uploads that have been uploaded but not yet consumed by an agent */
	pending: PendingUpload[]
}
