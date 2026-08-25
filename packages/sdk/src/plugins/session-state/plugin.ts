/**
 * Typed persistent state shared by agents, clients, and system callers.
 */
import z from 'zod/v4'
import { ValidationErrors } from '~/core/errors.js'
import { createEventsFactory } from '~/core/events/types.js'
import type { CallerContext } from '~/core/plugins/plugin-builder.js'
import { definePlugin } from '~/core/plugins/plugin-builder.js'
import { selectPluginState } from '~/core/sessions/reducer.js'
import { getEntryAgentId } from '~/core/sessions/state.js'
import { Err, Ok } from '~/lib/utils/result.js'

export const DEFAULT_SESSION_STATE_MAX_BYTES = 256 * 1024

const stateRecordSchema = z.record(z.string(), z.unknown())

function isStateRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
	const prototype = Object.getPrototypeOf(value)
	return prototype === Object.prototype || prototype === null
}

export const sessionStateEvents = createEventsFactory({
	events: {
		// Legacy full snapshots remain readable for existing event logs.
		session_state_updated: z.object({
			state: stateRecordSchema,
			callerSource: z.enum(['agent', 'client', 'system']),
		}),
		session_state_patched: z.object({
			set: stateRecordSchema,
			deletedKeys: z.array(z.string()),
			callerSource: z.enum(['agent', 'client', 'system']),
			externalRevision: z.number().int().nonnegative().optional(),
		}),
		session_state_external_consumed: z.object({
			updates: z.array(z.object({
				key: z.string(),
				revision: z.number().int().nonnegative(),
			})).optional(),
		}),
	},
})

export interface SessionStatePluginConfig {
	schema: z.ZodType
	initial: Record<string, unknown>
	validate?: (current: Record<string, unknown>, proposed: Record<string, unknown>, caller: CallerContext) => true | string
	/** Maximum UTF-8 JSON size of the resulting full state. */
	maxSerializedBytes?: number
}

interface PendingExternalUpdate {
	key: string
	revision: number
}

interface SessionStatePluginState {
	state: Record<string, unknown>
	pendingExternalUpdates: Map<string, number>
	nextExternalRevision: number
	initialized: boolean
}

type StateValidationResult =
	| { ok: true; state: Record<string, unknown> }
	| { ok: false; message: string }

function validateState(config: SessionStatePluginConfig, input: unknown): StateValidationResult {
	const configuredResult = config.schema.safeParse(input)
	if (!configuredResult.success) {
		return { ok: false, message: `Schema validation failed: ${configuredResult.error.message}` }
	}

	if (!isStateRecord(configuredResult.data)) {
		return { ok: false, message: `Schema validation failed: session state must be an object` }
	}

	let serialized: string
	try {
		serialized = JSON.stringify(configuredResult.data, (_key, value: unknown) => {
			if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
				throw new Error(`Unsupported JSON value: ${value === undefined ? 'undefined' : typeof value}`)
			}
			if (typeof value === 'number' && !Number.isFinite(value)) {
				throw new Error('Unsupported JSON value: non-finite number')
			}
			return value
		})
	} catch (error) {
		return { ok: false, message: `Session state is not JSON serializable: ${error instanceof Error ? error.message : String(error)}` }
	}

	const maxBytes = config.maxSerializedBytes ?? DEFAULT_SESSION_STATE_MAX_BYTES
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
		return { ok: false, message: 'Session state byte limit must be a non-negative safe integer' }
	}
	const actualBytes = new TextEncoder().encode(serialized).byteLength
	if (actualBytes > maxBytes) {
		return { ok: false, message: `Session state exceeds ${maxBytes} byte limit (${actualBytes} bytes)` }
	}

	const canonical: unknown = JSON.parse(serialized)
	if (!isStateRecord(canonical)) {
		return { ok: false, message: 'Session state JSON must decode to an object' }
	}
	return { ok: true, state: canonical }
}

function initializeState(config: SessionStatePluginConfig): SessionStatePluginState {
	const result = validateState(config, config.initial)
	if (!result.ok) {
		throw new Error(`Invalid initial session state: ${result.message}`)
	}
	return {
		state: result.state,
		pendingExternalUpdates: new Map(),
		nextExternalRevision: 0,
		initialized: true,
	}
}

function valuesEqual(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true
	return JSON.stringify(left) === JSON.stringify(right)
}

function changedKeys(current: Record<string, unknown>, next: Record<string, unknown>): string[] {
	const keys = new Set([...Object.keys(current), ...Object.keys(next)])
	return [...keys].filter((key) => {
		const currentHasKey = Object.hasOwn(current, key)
		const nextHasKey = Object.hasOwn(next, key)
		return currentHasKey !== nextHasKey || !valuesEqual(current[key], next[key])
	})
}

function createPatch(current: Record<string, unknown>, next: Record<string, unknown>) {
	const entries: Array<[string, unknown]> = []
	const deletedKeys: string[] = []
	for (const key of changedKeys(current, next)) {
		if (Object.hasOwn(next, key)) entries.push([key, next[key]])
		else deletedKeys.push(key)
	}
	return { set: Object.fromEntries(entries), deletedKeys }
}

function applyPatch(
	state: Record<string, unknown>,
	patch: { set: Record<string, unknown>; deletedKeys: string[] },
): Record<string, unknown> {
	const next = { ...state, ...patch.set }
	for (const key of patch.deletedKeys) delete next[key]
	return next
}

function addPendingUpdates(
	current: SessionStatePluginState,
	keys: string[],
	revision: number,
): Map<string, number> {
	const pending = new Map(current.pendingExternalUpdates)
	for (const key of keys) pending.set(key, revision)
	return pending
}

export const sessionStatePlugin = definePlugin('sessionState')
	.pluginConfig<SessionStatePluginConfig>()
	.isSessionEnabled(({ pluginConfig }) => pluginConfig !== undefined)
	.events([sessionStateEvents])
	.state({
		key: 'sessionState',
		initial: (): SessionStatePluginState => ({
			state: {},
			pendingExternalUpdates: new Map(),
			nextExternalRevision: 0,
			initialized: false,
		}),
		reduce: (uninitialized, event, _sessionState, pluginConfig) => {
			const current = uninitialized.initialized ? uninitialized : initializeState(pluginConfig)
			switch (event.type) {
				case 'session_state_updated': {
					const keys = changedKeys(current.state, event.state)
					if (event.callerSource === 'agent' || keys.length === 0) {
						return { ...current, state: event.state }
					}
					const revision = current.nextExternalRevision + 1
					return {
						...current,
						state: event.state,
						pendingExternalUpdates: addPendingUpdates(current, keys, revision),
						nextExternalRevision: revision,
					}
				}
				case 'session_state_patched': {
					const state = applyPatch(current.state, event)
					const keys = [...Object.keys(event.set), ...event.deletedKeys]
					if (event.callerSource === 'agent' || keys.length === 0) {
						return { ...current, state }
					}
					const revision = event.externalRevision ?? current.nextExternalRevision + 1
					return {
						...current,
						state,
						pendingExternalUpdates: addPendingUpdates(current, keys, revision),
						nextExternalRevision: Math.max(current.nextExternalRevision, revision),
					}
				}
				case 'session_state_external_consumed': {
					if (!event.updates) return { ...current, pendingExternalUpdates: new Map() }
					const pending = new Map(current.pendingExternalUpdates)
					for (const update of event.updates) {
						if (pending.get(update.key) === update.revision) pending.delete(update.key)
					}
					return { ...current, pendingExternalUpdates: pending }
				}
				default:
					return current
			}
		},
	})
	.context(async (ctx) => {
		const state = selectPluginState<SessionStatePluginState>(ctx.getSessionState(), 'sessionState')
		let nextExternalRevision = state?.nextExternalRevision ?? 0
		// `update` reads the committed state, validates a full merge and appends a
		// patch. Interleaving two of those merges the patches behind the validator,
		// so concurrent updates could land above the byte cap or break a cross-field
		// refinement that each of them satisfied on its own.
		let updateTail: Promise<unknown> = Promise.resolve()
		return {
			reserveExternalRevision: () => ++nextExternalRevision,
			runExclusive: <T>(operation: () => Promise<T>): Promise<T> => {
				const run = updateTail.then(operation, operation)
				updateTail = run.then(() => undefined, () => undefined)
				return run
			},
		}
	})
	.notification('sessionStateChanged', {
		schema: z.object({
			sessionId: z.string(),
			state: stateRecordSchema,
		}),
	})
	.method('get', {
		input: z.object({ sessionId: z.string() }),
		output: z.object({ state: stateRecordSchema }),
		handler: async (ctx) => Ok({ state: ctx.pluginState.state }),
	})
	.method('update', {
		input: z.object({
			sessionId: z.string(),
			updates: stateRecordSchema,
		}),
		output: z.object({ state: stateRecordSchema }),
		handler: async (ctx, input) => ctx.pluginContext.runExclusive(async () => {
			// Re-read inside the critical section: `ctx.pluginState` is a snapshot
			// taken before the handler ran, so an update that committed while this
			// call waited its turn would otherwise be merged away.
			const committed = selectPluginState<SessionStatePluginState>(ctx.getSessionState(), 'sessionState')?.state
				?? ctx.pluginState.state
			const proposed = { ...committed, ...input.updates }
			const parsed = validateState(ctx.pluginConfig, proposed)
			if (!parsed.ok) return Err(ValidationErrors.invalid(parsed.message))

			if (ctx.pluginConfig.validate) {
				const result = ctx.pluginConfig.validate(committed, parsed.state, ctx.caller)
				if (result !== true) return Err(ValidationErrors.invalid(result))
			}

			const patch = createPatch(committed, parsed.state)
			const keys = [...Object.keys(patch.set), ...patch.deletedKeys]
			if (keys.length === 0) return Ok({ state: parsed.state })

			const externalRevision = ctx.caller.source === 'agent'
				? undefined
				: ctx.pluginContext.reserveExternalRevision()
			await ctx.emitEvent(sessionStateEvents.create('session_state_patched', {
				...patch,
				callerSource: ctx.caller.source,
				externalRevision,
			}))

			ctx.notify('sessionStateChanged', {
				sessionId: String(ctx.sessionId),
				state: parsed.state,
			})

			if (ctx.caller.source !== 'agent') {
				const entryAgentId = getEntryAgentId(ctx.sessionState)
				if (entryAgentId) ctx.scheduleAgent(entryAgentId)
			}

			return Ok({ state: parsed.state })
		}),
	})
	.tool('update_session_state', {
		description: 'Update the session state. Use this to signal status changes (e.g., file ready for download, phase transitions).',
		input: z.object({
			updates: stateRecordSchema.describe('Key-value pairs to merge into the current session state'),
		}),
		execute: async (input, _toolCtx, ctx) => {
			const result = await ctx.self.update({
				sessionId: String(ctx.sessionId),
				updates: input.updates,
			})
			if (!result.ok) {
				return { ok: false, error: { message: result.error.message, recoverable: true } }
			}
			return { ok: true, value: [{ type: 'text', text: 'Session state updated.' }] }
		},
	})
	.dequeue<PendingExternalUpdate[]>({
		hasPendingMessages: (ctx) => ctx.pluginState.pendingExternalUpdates.size > 0,
		getPendingMessages: (ctx) => {
			if (ctx.pluginState.pendingExternalUpdates.size === 0) return null
			const updates = [...ctx.pluginState.pendingExternalUpdates].map(([key, revision]) => ({ key, revision }))
			return {
				messages: [{
					role: 'user',
					content: `<system>Session state was updated externally. Changed keys: ${updates.map((update) => update.key).join(', ')}.</system>`,
				}],
				token: updates,
			}
		},
		markConsumed: async (ctx, updates) => {
			await ctx.emitEvent(sessionStateEvents.create('session_state_external_consumed', { updates }))
		},
	})
	.systemPrompt((ctx) => {
		return `## Session State\n\nCurrent session state:\n\`\`\`json\n${JSON.stringify(ctx.pluginState.state, null, 2)}\n\`\`\`\n\nUse the \`update_session_state\` tool to update state values.`
	})
	.build()
