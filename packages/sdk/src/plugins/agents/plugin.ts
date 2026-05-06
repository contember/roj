/**
 * Agents Plugin - Spawn tools for child agent creation + agent management methods
 *
 * Generates `start_<agent_name>` tools for each spawnable agent defined in the agent config.
 * Tool executors delegate to the plugin's own `spawn` method via ctx.self.spawn().
 *
 * Also provides session-level methods for agent management:
 * - agents.spawn — spawn agent manually
 * - agents.resume — resume paused agent
 * - agents.pause — pause agent
 */

import z from 'zod/v4'
import { AgentId, agentIdSchema, generateAgentId } from '~/core/agents/schema.js'
import { type AgentState, agentEvents } from '~/core/agents/state.js'
import { AgentErrors, ValidationErrors } from '~/core/errors.js'
import { definePlugin } from '~/core/plugins/index.js'
import { getNextAgentSeq } from '~/core/sessions/state.js'
import { createTool } from '~/core/tools/definition.js'
import type { Logger } from '~/lib/logger/logger.js'
import { Err, Ok } from '~/lib/utils/result.js'
import { mailboxPlugin } from '~/plugins/mailbox/plugin.js'

/**
 * Information about a spawnable agent, used to generate typed start_<name> tools.
 */
export interface SpawnableAgentInfo {
	name: string
	description?: string
	inputSchema?: z.ZodType<unknown>
}

/**
 * Session-wide agents plugin configuration.
 * Maps agent name to its spawn info (description, input schema).
 */
export interface AgentsPluginConfig {
	/** Map of agent name → spawn info for generating typed tools */
	agentDefinitions: Map<string, SpawnableAgentInfo>
	/**
	 * Supervision tick interval (ms) for parent agents. Sends a periodic
	 * children-status snapshot via mailbox so the parent stays aware of long-running
	 * sub-agents and keeps prompt cache warm. Default: 240000 (4 min, just under
	 * the 5 min cache TTL). Set `false` to disable.
	 */
	superviseChildrenIntervalMs?: number | false
}

/** Default supervision interval — 4 min, just under prompt cache TTL. */
const DEFAULT_SUPERVISION_INTERVAL_MS = 240_000

/** Per-session runtime state held in plugin context — timers + trigger callback. */
interface AgentsPluginContext {
	timers: Map<AgentId, ReturnType<typeof setTimeout>>
	/** Set in onSessionReady — calls agents._supervisionTick via callPluginMethod (fresh ctx). */
	triggerTick: ((agentId: AgentId) => Promise<unknown>) | null
	/** null = supervision disabled for this session. */
	intervalMs: number | null
	logger: Logger | null
}

/**
 * Get all direct children of an agent.
 */
function getDirectChildren(sessionAgents: Map<AgentId, AgentState>, parentId: AgentId): AgentState[] {
	const out: AgentState[] = []
	for (const agent of sessionAgents.values()) {
		if (agent.parentId === parentId) out.push(agent)
	}
	return out
}

/**
 * Count assistant tool calls across conversation history + currently pending.
 */
function countToolCalls(state: AgentState): number {
	let total = state.pendingToolCalls.length
	for (const m of state.conversationHistory) {
		if (m.role === 'assistant' && m.toolCalls) total += m.toolCalls.length
	}
	return total
}

/**
 * Count completed LLM inferences (= assistant turns in history).
 */
function countLLMCalls(state: AgentState): number {
	let total = 0
	for (const m of state.conversationHistory) {
		if (m.role === 'assistant') total++
	}
	return total
}

/**
 * Build a compact "first N words..last M words" preview of the agent's most
 * recent assistant message (skipping empty turns). Returns null if none.
 */
function previewLastAssistant(state: AgentState, headWords = 5, tailWords = 5): string | null {
	for (let i = state.conversationHistory.length - 1; i >= 0; i--) {
		const m = state.conversationHistory[i]
		if (m.role !== 'assistant') continue
		const text = m.content?.trim()
		if (!text) continue
		const words = text.split(/\s+/)
		if (words.length <= headWords + tailWords + 1) return text
		return `${words.slice(0, headWords).join(' ')}..${words.slice(-tailWords).join(' ')}`
	}
	return null
}

/**
 * Build a compact children-status snapshot for the given parent agent.
 */
function buildChildrenStatus(sessionAgents: Map<AgentId, AgentState>, parentId: AgentId): string {
	const children = getDirectChildren(sessionAgents, parentId)
	const lines = children.map((c) => {
		const tools = countToolCalls(c)
		const llm = countLLMCalls(c)
		const subs = getDirectChildren(sessionAgents, c.id).length
		const last = previewLastAssistant(c)

		const parts: string[] = [c.id, c.status]
		parts.push(`${tools} tools`)
		parts.push(`${llm} llm`)
		if (subs > 0) parts.push(`${subs} sub${subs === 1 ? '' : 's'}`)
		if (last) parts.push(`last "${last.replaceAll('"', "'")}"`)

		return parts.join(', ')
	})

	return `<children-status>\n${lines.join('\n')}\n</children-status>`
}

/**
 * (Re)schedule a supervision tick for an agent. Any existing timer is cleared first.
 */
function scheduleSupervisionTick(
	pluginContext: AgentsPluginContext,
	agentId: AgentId,
	delayMs: number,
): void {
	const existing = pluginContext.timers.get(agentId)
	if (existing) clearTimeout(existing)

	const timer = setTimeout(() => {
		pluginContext.timers.delete(agentId)
		const trigger = pluginContext.triggerTick
		if (!trigger) return
		trigger(agentId).catch((err) => {
			pluginContext.logger?.error(
				'Supervision tick failed',
				err instanceof Error ? err : undefined,
				{ agentId },
			)
		})
	}, delayMs)

	pluginContext.timers.set(agentId, timer)
}

/**
 * Creates the Zod schema for a start_<agent_name> tool.
 * If the agent has an inputSchema, includes a typed `input` field.
 */
function createStartAgentSchema(agent: SpawnableAgentInfo) {
	if (agent.inputSchema) {
		return z.object({
			message: z.string().describe('Task description for the agent'),
			input: agent.inputSchema.describe('Typed input for the agent'),
		})
	}
	return z.object({
		message: z.string().describe('Task description for the agent'),
	})
}

export const agentsPlugin = definePlugin('agents')
	.pluginConfig<AgentsPluginConfig>()
	.dependencies([mailboxPlugin])
	.context(async (): Promise<AgentsPluginContext> => ({
		timers: new Map(),
		triggerTick: null,
		intervalMs: null,
		logger: null,
	}))
	.isEnabled((ctx) => {
		return ctx.agentConfig.spawnableAgents.length > 0
	})
	.method('spawn', {
		input: z.object({
			definitionName: z.string(),
			parentId: agentIdSchema,
			message: z.string().optional(),
			typedInput: z.unknown().optional(),
		}),
		output: z.object({
			agentId: agentIdSchema,
		}),
		handler: async (ctx, input) => {
			const parentId = AgentId(input.parentId)

			// Validate parent exists
			if (!ctx.sessionState.agents.has(parentId)) {
				return Err(AgentErrors.notFound(String(parentId)))
			}

			// Validate definition exists
			if (!ctx.pluginConfig.agentDefinitions.has(input.definitionName)) {
				return Err(ValidationErrors.invalid(`Agent definition not found: ${input.definitionName}`))
			}

			// Generate agent ID and emit spawn event
			const agentId = generateAgentId(input.definitionName, getNextAgentSeq(ctx.sessionState, input.definitionName))
			await ctx.emitEvent(agentEvents.create('agent_spawned', {
				agentId,
				definitionName: input.definitionName,
				parentId,
				...(input.typedInput !== undefined && { typedInput: input.typedInput }),
			}))

			// Optionally send initial message via mailbox plugin
			if (input.message) {
				const sendResult = await ctx.deps.mailbox.send({
					fromAgentId: parentId,
					toAgentId: agentId,
					content: input.message,
				})
				if (!sendResult.ok) return sendResult
			}

			ctx.logger.info('Agent spawned via agents.spawn', {
				agentId,
				definitionName: input.definitionName,
				parentId: input.parentId,
			})

			// Ensure parent has a supervision tick running now that it has a child.
			if (ctx.pluginContext.intervalMs !== null) {
				scheduleSupervisionTick(ctx.pluginContext, parentId, ctx.pluginContext.intervalMs)
			}

			return Ok({ agentId })
		},
	})
	.method('resume', {
		input: z.object({
			agentId: agentIdSchema,
		}),
		output: z.object({}),
		handler: async (ctx, input) => {
			const agentId = AgentId(input.agentId)

			// Validate agent exists and is paused or errored
			const agentState = ctx.sessionState.agents.get(agentId)
			if (!agentState) {
				return Err(AgentErrors.notFound(String(agentId)))
			}
			if (agentState.status !== 'paused' && agentState.status !== 'errored') {
				return Err(ValidationErrors.invalid('Agent is not paused or errored'))
			}

			await ctx.emitEvent(agentEvents.create('agent_resumed', { agentId }))
			ctx.scheduleAgent(agentId)

			ctx.logger.info('Agent resumed via agents.resume', { agentId: input.agentId })

			return Ok({})
		},
	})
	.method('pause', {
		input: z.object({
			agentId: agentIdSchema,
			message: z.string().optional(),
		}),
		output: z.object({}),
		handler: async (ctx, input) => {
			const agentId = AgentId(input.agentId)

			// Validate agent exists and is not already paused
			const agentState = ctx.sessionState.agents.get(agentId)
			if (!agentState) {
				return Err(AgentErrors.notFound(String(agentId)))
			}
			if (agentState.status === 'paused') {
				return Err(ValidationErrors.invalid('Agent is already paused'))
			}

			await ctx.emitEvent(agentEvents.create('agent_paused', {
				agentId,
				reason: 'manual',
				message: input.message,
			}))

			ctx.logger.info('Agent paused via agents.pause', { agentId: input.agentId })

			return Ok({})
		},
	})
	.method('rewind', {
		input: z.object({
			agentId: agentIdSchema,
			messageIndex: z.number().int().min(0),
		}),
		output: z.object({}),
		handler: async (ctx, input) => {
			const agentId = AgentId(input.agentId)
			const agentState = ctx.sessionState.agents.get(agentId)
			if (!agentState) {
				return Err(AgentErrors.notFound(String(agentId)))
			}

			if (input.messageIndex >= agentState.conversationHistory.length) {
				return Err(ValidationErrors.invalid('messageIndex out of range'))
			}

			const deleteCount = agentState.conversationHistory.length - input.messageIndex

			await ctx.emitEvent(agentEvents.create('agent_conversation_spliced', {
				agentId,
				start: input.messageIndex,
				deleteCount,
			}))
			ctx.scheduleAgent(agentId)

			ctx.logger.info('Agent rewound via agents.rewind', { agentId: input.agentId, messageIndex: input.messageIndex })

			return Ok({})
		},
	})
	.method('_supervisionTick', {
		input: z.object({ agentId: agentIdSchema }),
		output: z.object({}),
		handler: async (ctx, input) => {
			const agentId = AgentId(input.agentId)

			// Self may already be gone (terminated mid-tick); just stop.
			if (!ctx.sessionState.agents.has(agentId)) return Ok({})

			const children = getDirectChildren(ctx.sessionState.agents, agentId)
			if (children.length === 0) {
				// No active children → don't reschedule. spawn() will re-arm if/when needed.
				return Ok({})
			}

			const snapshot = buildChildrenStatus(ctx.sessionState.agents, agentId)
			const sendResult = await ctx.deps.mailbox.send({
				toAgentId: agentId,
				content: snapshot,
				fromSupervisor: true,
			})
			if (!sendResult.ok) {
				ctx.logger.warn('Supervision snapshot send failed', {
					agentId,
					error: sendResult.error.message,
				})
			}

			// Reschedule the next tick from now (rolling).
			if (ctx.pluginContext.intervalMs !== null) {
				scheduleSupervisionTick(ctx.pluginContext, agentId, ctx.pluginContext.intervalMs)
			}

			return Ok({})
		},
	})
	.sessionHook('onSessionReady', async (ctx) => {
		const intervalConfig = ctx.pluginConfig.superviseChildrenIntervalMs
		if (intervalConfig === false) {
			ctx.pluginContext.intervalMs = null
			return
		}
		const intervalMs = intervalConfig ?? DEFAULT_SUPERVISION_INTERVAL_MS
		ctx.pluginContext.intervalMs = intervalMs
		ctx.pluginContext.logger = ctx.logger

		// Wire the trigger callback — calls back via self.* so each tick gets a
		// fresh ctx (live sessionState/pluginState/deps).
		ctx.pluginContext.triggerTick = (agentId) => ctx.self._supervisionTick({ agentId })

		// (Re-)schedule timers for every agent that currently has direct children.
		// Covers initial session creation AND server-restart reload (onSessionReady
		// fires in both paths). Worst-case drift after restart = intervalMs.
		for (const agent of ctx.sessionState.agents.values()) {
			if (getDirectChildren(ctx.sessionState.agents, agent.id).length > 0) {
				scheduleSupervisionTick(ctx.pluginContext, agent.id, intervalMs)
			}
		}
	})
	.sessionHook('onSessionClose', async (ctx) => {
		for (const t of ctx.pluginContext.timers.values()) clearTimeout(t)
		ctx.pluginContext.timers.clear()
		ctx.pluginContext.triggerTick = null
	})
	.hook('afterInference', async (ctx) => {
		// Natural inference warmed the cache — push the next tick out by intervalMs
		// so we don't double-charge for parents who are already actively interacting.
		if (ctx.pluginContext.intervalMs !== null) {
			if (getDirectChildren(ctx.sessionState.agents, ctx.agentId).length > 0) {
				scheduleSupervisionTick(ctx.pluginContext, ctx.agentId, ctx.pluginContext.intervalMs)
			}
		}
		return null
	})
	.systemPrompt(() => {
		return `## Working with Child Agents

- **New task** → spawn a new agent using \`start_<agent_name>\`. You will receive the agent's ID in the result — use it with \`send_message\` for follow-up communication.
- **Follow-up on an existing task** → send a message to the existing agent via \`send_message\` with the agent's ID. Do NOT spawn a new agent for feedback, corrections, or additional instructions on a task already assigned.
- Spawned agents communicate back to you via \`send_message\`. Check your incoming messages for their results and progress updates.

### Supervision messages

You will periodically receive a \`<children-status>\` message from \`from="supervisor"\`. It is a status snapshot of your direct children — purely informational. Per child you'll see status, cumulative tool/llm call counts, sub-agent count, and a "first words..last words" preview of their last assistant turn.

Do NOT act on a supervision tick unless something is genuinely wrong (a child has been errored or stuck for a long time, you have a deadline, etc.). Most of the time you should just wait. Never reply to the supervisor.`
	})
	.tools((ctx) => {
		const spawnableAgents = ctx.agentConfig.spawnableAgents
		const agentDefs = ctx.pluginConfig.agentDefinitions

		return spawnableAgents.map((agentName) => {
			const agentInfo = agentDefs.get(agentName) ?? { name: agentName }
			const toolName = `start_${agentInfo.name}`
			const description = agentInfo.description
				? `Start a new ${agentInfo.name} agent. ${agentInfo.description} Use send_message with the returned agent ID for follow-up communication. Only spawn for NEW tasks — for follow-ups on existing tasks, use send_message to the existing agent.`
				: `Start a new ${agentInfo.name} agent to handle a specific task. Use send_message with the returned agent ID for follow-up communication. Only spawn for NEW tasks — for follow-ups on existing tasks, use send_message to the existing agent.`

			return createTool({
				name: toolName,
				description,
				input: createStartAgentSchema(agentInfo),
				execute: async (input) => {
					const typedInput = 'input' in input ? input.input : undefined
					const messageContent = typedInput !== undefined ? JSON.stringify(typedInput) : input.message

					const result = await ctx.self.spawn({
						definitionName: agentInfo.name,
						parentId: ctx.agentId,
						message: messageContent,
						...(typedInput !== undefined && { typedInput }),
					})

					if (!result.ok) {
						return Err({ message: result.error.message, recoverable: false })
					}

					const spawnedId = result.value.agentId
					return Ok(`Agent "${agentInfo.name}" spawned with ID ${spawnedId}. Use send_message with to: "${spawnedId}" to communicate with it.`)
				},
			})
		})
	})
	.build()
