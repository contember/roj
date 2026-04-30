import z4 from 'zod/v4'
import { AgentId, agentIdSchema } from '~/core/agents'
import { COMMUNICATOR_ROLE, ORCHESTRATOR_ROLE } from '~/core/agents/agent-roles'
import { createEventsFactory } from '~/core/events/types'
import { messageIdSchema } from '~/plugins/mailbox/schema'
import { uploadIdSchema } from '~/plugins/uploads/schema'
import { WorkerId, workerIdSchema } from '../workers/worker.js'

export type MailboxMessageSender =
	| AgentId
	| WorkerId
	| 'user'
	| 'debug'
	| typeof ORCHESTRATOR_ROLE
	| typeof COMMUNICATOR_ROLE

export const mailboxEvents = createEventsFactory({
	events: {
		mailbox_message: z4.object({
			toAgentId: agentIdSchema,
			message: z4.object({
				id: messageIdSchema,
				from: z4.union([
					agentIdSchema,
					workerIdSchema,
					z4.enum(['user', 'debug', COMMUNICATOR_ROLE, ORCHESTRATOR_ROLE]),
				]),
				content: z4.string(),
				timestamp: z4.number(),
				consumed: z4.boolean(),
				answerTo: messageIdSchema.optional(),
				answerValue: z4.unknown().optional(),
				attachments: z4.array(z4.object({
					uploadId: uploadIdSchema,
					filename: z4.string(),
					mimeType: z4.string(),
					size: z4.number(),
					path: z4.string(),
					extractedContent: z4.string().optional(),
					derivedPaths: z4.array(z4.string()).optional(),
				})).optional(),
			}),
		}),
		mailbox_consumed: z4.object({
			agentId: agentIdSchema,
			messageIds: z4.array(messageIdSchema),
		}),
	},
})

export type MailboxMessageEvent = (typeof mailboxEvents)['Events']['mailbox_message']
export type MailboxConsumedEvent = (typeof mailboxEvents)['Events']['mailbox_consumed']
