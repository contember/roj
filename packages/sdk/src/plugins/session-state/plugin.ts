/**
 * Session State Plugin
 *
 * Provides a typed, persistent state object per session that can be updated by:
 * - Agent (via tool)
 * - Client/SPA (via RPC method)
 * - Backend/system (via RPC method with system caller context)
 *
 * State changes are broadcast as notifications and can trigger agent dequeue.
 * A preset-defined validate function controls write permissions per caller.
 */
import z from 'zod/v4'
import type { CallerContext } from '~/core/plugins/plugin-builder.js'
import { definePlugin } from '~/core/plugins/plugin-builder.js'
import { createEventsFactory } from '~/core/events/types.js'
import { getEntryAgentId } from '~/core/sessions/state.js'
import { Err, Ok } from '~/lib/utils/result.js'
import { ValidationErrors } from '~/core/errors.js'

export const sessionStateEvents = createEventsFactory({
	events: {
		session_state_updated: z.object({
			state: z.record(z.string(), z.unknown()),
			callerSource: z.enum(['agent', 'client', 'system']),
		}),
		session_state_external_consumed: z.object({}),
	},
})

export interface SessionStatePluginConfig {
	schema: z.ZodType
	initial: Record<string, unknown>
	validate?: (current: Record<string, unknown>, proposed: Record<string, unknown>, caller: CallerContext) => true | string
}

interface SessionStatePluginState {
	state: Record<string, unknown>
	pendingExternalUpdate: boolean
}

export const sessionStatePlugin = definePlugin('sessionState')
	.pluginConfig<SessionStatePluginConfig>()
	.isSessionEnabled(({ pluginConfig }) => pluginConfig !== undefined)
	.events([sessionStateEvents])
	.state({
		key: 'sessionState',
		initial: (): SessionStatePluginState => ({ state: {}, pendingExternalUpdate: false }),
		reduce: (current, event, _sessionState, pluginConfig) => {
			switch (event.type) {
				case 'session_state_updated':
					return {
						state: event.state as Record<string, unknown>,
						pendingExternalUpdate: event.callerSource !== 'agent',
					}
				case 'session_state_external_consumed':
					return { ...current, pendingExternalUpdate: false }
				default:
					// Initialize with config defaults if state is empty and config is available
					if (pluginConfig && Object.keys(current.state).length === 0) {
						return { ...current, state: (pluginConfig as SessionStatePluginConfig).initial }
					}
					return current
			}
		},
	})
	.notification('sessionStateChanged', {
		schema: z.object({
			sessionId: z.string(),
			state: z.record(z.string(), z.unknown()),
		}),
	})
	.method('get', {
		input: z.object({ sessionId: z.string() }),
		output: z.object({ state: z.record(z.string(), z.unknown()) }),
		handler: async (ctx) => {
			const currentState = ctx.pluginState.state
			const config = ctx.pluginConfig
			const state = Object.keys(currentState).length === 0 && config ? config.initial : currentState
			return Ok({ state })
		},
	})
	.method('update', {
		input: z.object({
			sessionId: z.string(),
			updates: z.record(z.string(), z.unknown()),
		}),
		output: z.object({ state: z.record(z.string(), z.unknown()) }),
		handler: async (ctx, input) => {
			const config = ctx.pluginConfig
			if (!config) return Err(ValidationErrors.invalid('Session state plugin not configured'))

			const currentState = Object.keys(ctx.pluginState.state).length === 0
				? config.initial
				: ctx.pluginState.state

			const proposed = { ...currentState, ...input.updates }

			// Validate against schema
			const parsed = config.schema.safeParse(proposed)
			if (!parsed.success) {
				return Err(ValidationErrors.invalid(`Schema validation failed: ${parsed.error.message}`))
			}

			// Run custom validate function
			if (config.validate) {
				const result = config.validate(currentState, proposed, ctx.caller)
				if (result !== true) {
					return Err(ValidationErrors.invalid(result))
				}
			}

			// Emit event
			await ctx.emitEvent(sessionStateEvents.create('session_state_updated', {
				state: proposed,
				callerSource: ctx.caller.source,
			}))

			// Notify connected clients
			ctx.notify('sessionStateChanged', {
				sessionId: String(ctx.sessionId),
				state: proposed,
			})

			// Schedule agent if external update
			if (ctx.caller.source !== 'agent') {
				const entryAgentId = getEntryAgentId(ctx.sessionState)
				if (entryAgentId) {
					ctx.scheduleAgent(entryAgentId)
				}
			}

			return Ok({ state: proposed })
		},
	})
	.tool('update_session_state', {
		description: 'Update the session state. Use this to signal status changes (e.g., file ready for download, phase transitions).',
		input: z.object({
			updates: z.record(z.string(), z.unknown()).describe('Key-value pairs to merge into the current session state'),
		}),
		execute: async (input, _toolCtx, ctx) => {
			const result = await ctx.self.update({
				sessionId: String(ctx.sessionId),
				updates: input.updates,
			})

			if (typeof result === 'object' && result !== null && 'ok' in result && !(result as { ok: boolean }).ok) {
				const err = result as { ok: false; error: { message: string } }
				return { ok: false, error: { message: err.error.message, recoverable: true } }
			}

			return { ok: true, value: [{ type: 'text' as const, text: 'Session state updated.' }] }
		},
	})
	.dequeue({
		hasPendingMessages: (ctx) => ctx.pluginState.pendingExternalUpdate,
		getPendingMessages: (ctx) => {
			if (!ctx.pluginState.pendingExternalUpdate) return null
			const stateStr = JSON.stringify(ctx.pluginState.state, null, 2)
			return {
				messages: [{
					role: 'user' as const,
					content: `<system>Session state was updated externally. Current state:\n${stateStr}</system>`,
				}],
				token: true,
			}
		},
		markConsumed: async (ctx) => {
			await ctx.emitEvent(sessionStateEvents.create('session_state_external_consumed', {}))
		},
	})
	.systemPrompt((ctx) => {
		const config = ctx.pluginConfig
		if (!config) return null
		const state = Object.keys(ctx.pluginState.state).length === 0
			? config.initial
			: ctx.pluginState.state
		return `## Session State\n\nCurrent session state:\n\`\`\`json\n${JSON.stringify(state, null, 2)}\n\`\`\`\n\nUse the \`update_session_state\` tool to update state values.`
	})
	.build()
