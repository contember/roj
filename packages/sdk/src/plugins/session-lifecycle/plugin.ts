/**
 * Session Lifecycle Plugin
 *
 * Manager methods: create, list, fork.
 * Session methods: get, close, reopen, getEvents.
 * Preset listing is a separate presetsPlugin.
 */

import z4 from 'zod/v4'
import { agentIdSchema } from '~/core/agents'
import { COMMUNICATOR_ROLE, ORCHESTRATOR_ROLE } from '~/core/agents/agent-roles.js'
import { type DomainError, PresetErrors, SessionErrors, ValidationErrors } from '~/core/errors.js'
import { definePlugin } from '~/core/plugins/index.js'
import { knownDefinitionNames, unknownOverrideTargets } from '~/core/preset/overrides.js'
import { SessionId, sessionIdSchema, sessionMetadataSchema } from '~/core/sessions/schema.js'
import { agentOverridesSchema, getEntryAgentId, sessionEvents, sessionOverridesPatchSchema } from '~/core/sessions/state.js'
import { Err, Ok } from '~/lib/utils/result.js'

// ============================================================================
// Presets Plugin — provides presets.list
// ============================================================================

export const presetsPlugin = definePlugin('presets')
	.managerMethod('list', {
		input: z4.object({}),
		output: z4.object({
			presets: z4.array(z4.object({
				id: z4.string(),
				name: z4.string(),
				description: z4.string().optional(),
				defaultResourceSlugs: z4.array(z4.string()).optional(),
			})),
		}),
		handler: async (ctx) => {
			const presets: Array<{ id: string; name: string; description?: string; defaultResourceSlugs?: string[] }> = []
			for (const p of ctx.presets.values()) {
				presets.push({
					id: p.id,
					name: p.name,
					description: p.description,
					defaultResourceSlugs: p.defaultResourceSlugs,
				})
			}
			return Ok({ presets })
		},
	})
	.managerMethod('getAgents', {
		input: z4.object({
			sessionId: sessionIdSchema,
		}),
		output: z4.object({
			agents: z4.array(z4.object({
				name: z4.string(),
				spawnableBy: z4.array(z4.string()),
				hasInputSchema: z4.boolean(),
			})),
		}),
		handler: async (ctx, input) => {
			const sm = ctx.sessionManager
			const sessionId = SessionId(input.sessionId)

			const sessionResult = await sm.getSession(sessionId)
			if (!sessionResult.ok) return sessionResult

			const session = sessionResult.value

			// session.state gives us the presetId; look up the preset
			const presetId = session.state.presetId
			const preset = ctx.presets.get(presetId)
			if (!preset) {
				return Err(PresetErrors.notFound(presetId))
			}

			// Build reverse map: for each agent definition, which parents can spawn it
			const agents: Array<{ name: string; spawnableBy: string[]; hasInputSchema: boolean }> = []

			for (const agentDef of preset.agents) {
				const spawnableBy: string[] = []

				// Check orchestrator
				if (preset.orchestrator.agents?.includes(agentDef.name)) {
					spawnableBy.push(ORCHESTRATOR_ROLE)
				}

				// Check communicator
				if (preset.communicator?.agents?.includes(agentDef.name)) {
					spawnableBy.push(COMMUNICATOR_ROLE)
				}

				// Check other agents
				for (const other of preset.agents) {
					if (other.agents?.includes(agentDef.name)) {
						spawnableBy.push(other.name)
					}
				}

				agents.push({
					name: agentDef.name,
					spawnableBy,
					hasInputSchema: !!agentDef.input,
				})
			}

			return Ok({ agents })
		},
	})
	.build()

// ============================================================================
// Sessions Plugin — manager: create, list, fork; session: get, close, reopen
// ============================================================================

export const sessionLifecyclePlugin = definePlugin('sessions')
	.managerMethod('create', {
		input: z4.object({
			presetId: z4.string().min(1),
			workspaceDir: z4.string().optional(),
			sessionId: z4.string().optional(),
			overrides: sessionOverridesPatchSchema.optional(),
		}),
		output: z4.object({
			sessionId: sessionIdSchema,
		}),
		handler: async (ctx, input) => {
			const sm = ctx.sessionManager

			ctx.logger.info('sessions.create called', {
				presetId: input.presetId,
				workspaceDir: input.workspaceDir ?? null,
				sessionId: input.sessionId ?? null,
				overrides: input.overrides ?? null,
			})

			const sessionResult = await sm.createSession(input.presetId, {
				workspaceDir: input.workspaceDir,
				sessionId: input.sessionId,
				overrides: input.overrides,
			})
			if (!sessionResult.ok) return sessionResult

			const session = sessionResult.value

			ctx.logger.info('Session created', {
				sessionId: session.id,
				workspaceDir: session.state.workspaceDir ?? null,
			})

			return Ok({ sessionId: session.id })
		},
	})
	.managerMethod('list', {
		input: z4.object({
			status: z4.enum(['active', 'closed', 'errored']).optional(),
			tags: z4.array(z4.string()).optional(),
			limit: z4.number().int().min(1).max(100).optional(),
			offset: z4.number().int().min(0).optional(),
			orderBy: z4.enum(['createdAt', 'lastActivityAt']).optional(),
			order: z4.enum(['asc', 'desc']).optional(),
		}),
		output: z4.object({
			// The handler returns SessionMetadata[]; z.unknown() used to hide that
			// from every caller, which is how standalone-server's sessions.list
			// drifted from the platform contract unnoticed.
			sessions: z4.array(sessionMetadataSchema),
			total: z4.number(),
		}),
		handler: async (ctx, input) => {
			const result = await ctx.eventStore.listSessionsWithMetadata({
				status: input.status,
				tags: input.tags,
				limit: input.limit,
				offset: input.offset,
				orderBy: input.orderBy,
				order: input.order,
			})

			return Ok({
				sessions: result.sessions,
				total: result.total,
			})
		},
	})
	.method('get', {
		input: z4.object({}),
		output: z4.object({
			sessionId: sessionIdSchema,
			presetId: z4.string(),
			status: z4.string(),
			createdAt: z4.number(),
			closedAt: z4.number().optional(),
			agentCount: z4.number(),
			entryAgentId: agentIdSchema.nullable(),
			// Reported back so a caller can tell "the override did not apply" from
			// "this build predates overrides and dropped the field on input".
			overrides: z4.object({
				defaults: agentOverridesSchema.optional(),
				agents: z4.record(z4.string(), agentOverridesSchema),
			}),
		}),
		handler: async (ctx) => {
			const state = ctx.sessionState
			return Ok({
				sessionId: ctx.sessionId,
				presetId: state.presetId,
				status: state.status,
				createdAt: state.createdAt,
				closedAt: state.closedAt,
				agentCount: state.agents.size,
				entryAgentId: getEntryAgentId(state),
				overrides: {
					defaults: state.overrides.defaults,
					agents: Object.fromEntries(state.overrides.agents),
				},
			})
		},
	})
	// A manager method, not a session method, purely so it can see the preset and
	// reject unknown agent names — session method contexts carry no preset.
	// `presets.getAgents` is a manager method for the same reason.
	.managerMethod('setOverrides', {
		input: z4.object({
			sessionId: sessionIdSchema,
			overrides: sessionOverridesPatchSchema,
		}),
		output: z4.object({
			agents: z4.record(z4.string(), agentOverridesSchema),
			defaults: agentOverridesSchema.optional(),
		}),
		handler: async (ctx, input) => {
			const sm = ctx.sessionManager
			const sessionId = SessionId(input.sessionId)

			return sm.withSessionLease(sessionId, 'manager:sessions.setOverrides', async (session) => {
				const preset = ctx.presets.get(session.state.presetId)
				if (!preset) return Err(PresetErrors.notFound(session.state.presetId))

				const unknown = unknownOverrideTargets(preset, input.overrides)
				if (unknown.length > 0) {
					return Err(ValidationErrors.invalid(
						`Unknown agent definitions in overrides: ${unknown.join(', ')}. Preset '${preset.id}' defines: ${knownDefinitionNames(preset).join(', ')}`,
					))
				}

				const setResult = await session.setOverrides(input.overrides)
				if (!setResult.ok) return setResult

				// Agents already mid-turn finish on the model they started with: the
				// override is read when the next inference request is built, not applied
				// retroactively to one in flight.
				ctx.logger.info('Session overrides set', { sessionId, overrides: input.overrides })

				const state = session.state
				return Ok({
					agents: Object.fromEntries(state.overrides.agents),
					defaults: state.overrides.defaults,
				})
			})
		},
	})
	.managerMethod('fork', {
		input: z4.object({
			sessionId: sessionIdSchema,
			eventIndex: z4.number().int().min(0),
		}),
		output: z4.object({
			sessionId: sessionIdSchema,
		}),
		handler: async (ctx, input) => {
			const sm = ctx.sessionManager

			const forkedResult = await sm.forkSession(input.sessionId, input.eventIndex)
			if (!forkedResult.ok) return forkedResult

			const forked = forkedResult.value

			ctx.logger.info('Session forked', {
				sourceSessionId: input.sessionId,
				newSessionId: forked.id,
				eventIndex: input.eventIndex,
			})

			return Ok({ sessionId: forked.id })
		},
	})
	.method('close', {
		input: z4.object({}),
		output: z4.object({}),
		handler: async (ctx) => {
			if (ctx.sessionState.status === 'closed') {
				return Err(SessionErrors.closed(String(ctx.sessionId)))
			}
			await ctx.emitEvent(sessionEvents.create('session_closed', {}))
			return Ok({})
		},
	})
	.method('reopen', {
		input: z4.object({}),
		output: z4.object({}),
		handler: async (ctx) => {
			if (ctx.sessionState.status !== 'closed') {
				return Err(ValidationErrors.invalid('Session is not closed'))
			}
			await ctx.emitEvent(sessionEvents.create('session_reopened', {}))
			return Ok({})
		},
	})
	.method('updateMetadata', {
		input: z4.object({
			name: z4.string().min(1).max(100).optional(),
		}),
		output: z4.object({}),
		handler: async (ctx, input) => {
			await ctx.eventStore.updateMetadata(ctx.sessionId, input)
			return Ok({})
		},
	})
	.method('getEvents', {
		input: z4.object({
			since: z4.number().int().optional(),
			limit: z4.number().int().optional(),
			offset: z4.number().int().optional(),
			type: z4.string().optional(),
			agentId: z4.string().optional(),
		}),
		output: z4.object({
			events: z4.array(z4.unknown()),
			total: z4.number(),
			lastIndex: z4.number(),
		}),
		handler: async (ctx, input) => {
			// Use loadRange for efficient partial loading
			const { events: loadedEvents, toIndex } = await ctx.eventStore.loadRange(
				ctx.sessionId,
				{
					since: input.since,
					limit: input.limit ?? 1000,
				},
			)

			// Filter by type/agentId
			let filtered = loadedEvents
			if (input.type) {
				filtered = filtered.filter((e) => e.type === input.type)
			}
			if (input.agentId) {
				filtered = filtered.filter(
					(e) => 'agentId' in e && e.agentId === input.agentId,
				)
			}

			// Offset pagination (only when not using since)
			const offset = input.since === undefined ? (input.offset ?? 0) : 0
			const paginated = filtered.slice(offset, offset + (input.limit ?? 100))

			return Ok({
				events: paginated,
				total: filtered.length,
				lastIndex: toIndex,
			})
		},
	})
	.build()
