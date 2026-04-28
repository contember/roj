/**
 * Agent Status Plugin
 *
 * Emits agentStatus notifications to connected clients when the entry agent
 * starts/stops inference. This provides real-time "thinking" indicators in the UI.
 */

import z from 'zod/v4'
import { agentIdSchema, protocolAgentStatusSchema } from '~/core/agents/schema.js'
import { definePlugin } from '~/core/plugins/index.js'
import { sessionIdSchema } from '~/core/sessions/schema.js'

export const agentStatusPlugin = definePlugin('agent-status')
	.notification('agentStatus', {
		schema: z.object({
			sessionId: sessionIdSchema,
			agentId: agentIdSchema,
			status: protocolAgentStatusSchema,
			definitionName: z.string().optional(),
			timestamp: z.number(),
		}),
	})
	.hook('onStart', async (ctx) => {
		if (ctx.parentId !== null) {
			ctx.notify('agentStatus', {
				sessionId: ctx.sessionId,
				agentId: ctx.agentId,
				status: 'thinking',
				definitionName: ctx.agentState.definitionName,
				timestamp: Date.now(),
			})
		}
		return null
	})
	.hook('beforeInference', async (ctx) => {
		if (ctx.parentId === null) {
			ctx.notify('agentStatus', {
				sessionId: ctx.sessionId,
				agentId: ctx.agentId,
				status: 'thinking',
				timestamp: Date.now(),
			})
		}
		return null
	})
	.hook('onComplete', async (ctx) => {
		if (ctx.parentId !== null) {
			ctx.notify('agentStatus', {
				sessionId: ctx.sessionId,
				agentId: ctx.agentId,
				status: 'idle',
				definitionName: ctx.agentState.definitionName,
				timestamp: Date.now(),
			})
		} else {
			ctx.notify('agentStatus', {
				sessionId: ctx.sessionId,
				agentId: ctx.agentId,
				status: 'idle',
				timestamp: Date.now(),
			})
		}
		return null
	})
	.hook('onError', async (ctx) => {
		if (ctx.parentId !== null) {
			ctx.notify('agentStatus', {
				sessionId: ctx.sessionId,
				agentId: ctx.agentId,
				status: 'idle',
				definitionName: ctx.agentState.definitionName,
				timestamp: Date.now(),
			})
		}
		return null
	})
	.build()
