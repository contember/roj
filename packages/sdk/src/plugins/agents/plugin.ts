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
import type { SessionContext } from '~/core/sessions/context.js'
import { pluginWakeKey } from '~/core/wake-key.js'
import type { SessionState } from '~/core/sessions/state.js'
import { agentSequenceKey, getNextAgentSeq } from '~/core/sessions/state.js'
import { createTool } from '~/core/tools/definition.js'
import { Err, Ok } from '~/lib/utils/result.js'
import { mailboxPlugin } from '~/plugins/mailbox/plugin.js'
import { getAgentUnconsumedMailbox, selectMailboxState } from '~/plugins/mailbox/query.js'

const PLUGIN_NAME = 'agents'
const SUPERVISION_TICK_METHOD = '_supervisionTick'

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
	 * Supervision tick interval (ms) for parent agents. When set, parent agents
	 * with active children receive a periodic <children-status> snapshot via
	 * mailbox so they stay aware of long-running sub-agents and prompt cache
	 * stays warm.
	 *
	 * Default: undefined (disabled). Recommended: 240000 (4 min, just under
	 * the 5 min prompt cache TTL — see SUPERVISION_INTERVAL_CACHE_FRIENDLY).
	 */
	superviseChildrenIntervalMs?: number
}

/**
 * Recommended supervision interval — 4 min, just under prompt cache TTL.
 * Each tick triggers a parent inference, keeping the prompt cache warm.
 */
export const SUPERVISION_INTERVAL_CACHE_FRIENDLY = 240_000

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
 * Input waiting in the agent's queue that the loop will dequeue on its next turn.
 *
 * Incomplete on purpose, for want of a seam: `Agent.decide()` asks every plugin with
 * a `dequeue` hook (mailbox, user-chat, uploads) and nothing exposes that predicate
 * at session level, so a child fed only through user-chat or uploads reads as idle
 * here. See PR #18.
 */
function hasQueuedInput(sessionState: SessionState, agentId: AgentId): boolean {
	return getAgentUnconsumedMailbox(selectMailboxState(sessionState), agentId).length > 0
}

/**
 * Is this agent running, or holding input it will run?
 *
 * `paused` is the only status that never resumes on its own — everything else is
 * decided by the queue, exactly as `Agent.decide()` decides it. In particular an
 * `errored` agent is NOT idle: with its input still queued (a retryable failure
 * preserves the dequeue token) `decide()` returns `resume_from_error` and the
 * agent retries itself at the capped backoff.
 */
function isAgentWorking(sessionState: SessionState, agent: AgentState): boolean {
	if (agent.status === 'paused') return false
	if (agent.status === 'inferring' || agent.status === 'tool_exec') return true
	// decide() resumes an errored agent only for queued input — stale
	// pendingToolResults were already there when the inference failed.
	if (agent.status === 'errored') return hasQueuedInput(sessionState, agent.id)
	if (agent.pendingToolCalls.length > 0 || agent.pendingToolResults.length > 0) return true
	return hasQueuedInput(sessionState, agent.id)
}

/**
 * Is anything below this agent still working? Agents are never removed from
 * session state, so "has children" stays true forever and cannot gate the tick.
 * Walks the whole subtree — a child idling on its own children is still work.
 */
function hasWorkingDescendant(sessionState: SessionState, parentId: AgentId): boolean {
	const queue = getDirectChildren(sessionState.agents, parentId)
	const seen = new Set<AgentId>()
	for (let i = 0; i < queue.length; i++) {
		const agent = queue[i]
		if (seen.has(agent.id)) continue
		seen.add(agent.id)
		if (isAgentWorking(sessionState, agent)) return true
		queue.push(...getDirectChildren(sessionState.agents, agent.id))
	}
	return false
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
		// Surface why a child paused (e.g. budget/limit exhaustion) so the parent can
		// react — bump the budget and resume, reassign the work, or stop.
		if (c.status === 'paused' && c.pauseMessage) {
			parts.push(`reason: ${c.pauseMessage.replaceAll('"', "'")}`)
		}
		parts.push(`${tools} tools`)
		parts.push(`${llm} llm`)
		if (subs > 0) parts.push(`${subs} sub${subs === 1 ? '' : 's'}`)
		if (last) parts.push(`last "${last.replaceAll('"', "'")}"`)

		return parts.join(', ')
	})

	return `<children-status>\n${lines.join('\n')}\n</children-status>`
}

/** What arming a supervision wake needs, in every context that arms one. */
type SupervisionScheduling = Pick<SessionContext, 'platform' | 'sessionId' | 'logger'>

function supervisionWakeKey(ctx: SupervisionScheduling, agentId: AgentId): string {
	return pluginWakeKey(ctx.sessionId, PLUGIN_NAME, SUPERVISION_TICK_METHOD, agentId)
}

/**
 * (Re)arm the supervision tick for an agent.
 *
 * The wake carries no closure — it comes back as `agents._supervisionTick` on a
 * session loaded by id. `wake()` replaces any pending wake for the same key,
 * which is also how a natural inference pushes the next tick out.
 */
async function scheduleSupervisionTick(ctx: SupervisionScheduling, agentId: AgentId, delayMs: number): Promise<void> {
	try {
		await ctx.platform.scheduler.wake(supervisionWakeKey(ctx, agentId), delayMs)
	} catch (err) {
		ctx.logger.error('Failed to arm supervision wake', err instanceof Error ? err : undefined, { agentId })
	}
}

async function cancelSupervisionTick(ctx: SupervisionScheduling, agentId: AgentId): Promise<void> {
	try {
		await ctx.platform.scheduler.cancel(supervisionWakeKey(ctx, agentId))
	} catch (err) {
		ctx.logger.error('Failed to cancel supervision wake', err instanceof Error ? err : undefined, { agentId })
	}
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

export const agentsPlugin = definePlugin(PLUGIN_NAME)
	.order(40)
	.pluginConfig<AgentsPluginConfig>()
	.dependencies([mailboxPlugin])
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
			const seq = ctx.reserveSequence(
				agentSequenceKey(input.definitionName),
				() => getNextAgentSeq(ctx.getSessionState(), input.definitionName),
			)
			const agentId = generateAgentId(input.definitionName, seq)
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
			const intervalMs = ctx.pluginConfig.superviseChildrenIntervalMs
			if (intervalMs !== undefined) {
				await scheduleSupervisionTick(ctx, parentId, intervalMs)
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
	.method(SUPERVISION_TICK_METHOD, {
		input: z.object({ agentId: agentIdSchema }),
		output: z.object({}),
		handler: async (ctx, input) => {
			const agentId = AgentId(input.agentId)

			// Self may already be gone (terminated mid-tick); just stop.
			const agent = ctx.sessionState.agents.get(agentId)
			if (!agent) return Ok({})

			const children = getDirectChildren(ctx.sessionState.agents, agentId)
			if (children.length === 0) {
				// No active children → don't reschedule. spawn() will re-arm if/when needed.
				return Ok({})
			}

			// A paused parent cannot consume a snapshot — sending anyway piles one
			// un-consumable message per interval into its mailbox until it resumes.
			if (agent.status !== 'paused') {
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
			}

			// Reschedule the next tick from now (rolling), but only while something
			// below is still working — otherwise the tick would re-arm forever.
			// Read live state: the send above appended an event and dispatched
			// listeners, so ctx.sessionState is already behind by the time we decide.
			const intervalMs = ctx.pluginConfig.superviseChildrenIntervalMs
			if (intervalMs !== undefined && hasWorkingDescendant(ctx.getSessionState(), agentId)) {
				await scheduleSupervisionTick(ctx, agentId, intervalMs)
			}

			return Ok({})
		},
	})
	.sessionHook('onSessionReady', async (ctx) => {
		// Supervision is disabled by default; spawn() and afterInference() read the
		// same config and skip too.
		const intervalMs = ctx.pluginConfig.superviseChildrenIntervalMs
		if (intervalMs === undefined) return

		// (Re-)arm a wake for every agent that currently has direct children.
		// Covers initial session creation AND server-restart reload (onSessionReady
		// fires in both paths). Worst-case drift after restart = intervalMs.
		// Not gated on live status: a reload resets 'inferring' back to 'pending',
		// so the first tick — not this hook — decides whether to keep going.
		for (const agent of ctx.sessionState.agents.values()) {
			if (getDirectChildren(ctx.sessionState.agents, agent.id).length > 0) {
				await scheduleSupervisionTick(ctx, agent.id, intervalMs)
			}
		}
	})
	.sessionHook('onSessionClose', async (ctx) => {
		if (ctx.pluginConfig.superviseChildrenIntervalMs === undefined) return

		// Eviction runs this too, and onSessionReady re-arms on the next load —
		// so a parked session ticks no more often than a resident one.
		for (const agent of ctx.sessionState.agents.values()) {
			await cancelSupervisionTick(ctx, agent.id)
		}
	})
	.hook('afterInference', async (ctx) => {
		// Natural inference warmed the cache — push the next tick out by intervalMs
		// so we don't double-charge for parents who are already actively interacting.
		const intervalMs = ctx.pluginConfig.superviseChildrenIntervalMs
		if (intervalMs !== undefined && hasWorkingDescendant(ctx.sessionState, ctx.agentId)) {
			await scheduleSupervisionTick(ctx, ctx.agentId, intervalMs)
		}
		return null
	})
	.systemPrompt((ctx) => {
		const base = `## Working with Child Agents

- **New task** → spawn a new agent using \`start_<agent_name>\`. You will receive the agent's ID in the result — use it with \`send_message\` for follow-up communication.
- **Follow-up on an existing task** → send a message to the existing agent via \`send_message\` with the agent's ID. Do NOT spawn a new agent for feedback, corrections, or additional instructions on a task already assigned.
- Spawned agents communicate back to you via \`send_message\`. Check your incoming messages for their results and progress updates.
- If a child pauses early it sends you a \`<child-paused agent="…">reason</child-paused>\` message (e.g. it hit a cost/limit budget). Decide what to do: resume it with \`resume_agent\` **after addressing the cause**, reassign or drop the work, or stop. Resuming does not grant more budget — a child that hit a cost or token limit will stop again immediately, so don't retry it in a loop.`

		// Only include supervision instructions if supervision is actually enabled
		// for this session — otherwise the section is misleading bloat.
		if (ctx.pluginConfig.superviseChildrenIntervalMs === undefined) return base

		return `${base}

### Supervision messages

You will periodically receive a \`<children-status>\` message from \`from="supervisor"\`. It is a status snapshot of your direct children — purely informational. Per child you'll see status, cumulative tool/llm call counts, sub-agent count, and a "first words..last words" preview of their last assistant turn.

Do NOT act on a supervision tick unless something is genuinely wrong (a child has been errored or stuck for a long time, you have a deadline, etc.). Most of the time you should just wait. Never reply to the supervisor.`
	})
	.tools((ctx) => {
		const spawnableAgents = ctx.agentConfig.spawnableAgents
		const agentDefs = ctx.pluginConfig.agentDefinitions

		// The parent is told (see the `<child-paused>` line in the system prompt above) that it
		// may resume a paused child. Without this tool that instruction had nothing behind it:
		// `resume` existed only as a plugin method, reachable from outside the session via
		// `agents.resume`, so a child that paused stayed paused until something external
		// intervened. Only offered to agents that can actually have children.
		const resumeTool = createTool({
			name: 'resume_agent',
			description:
				'Resume one of your own child agents after it paused (you receive a <child-paused> message when that happens). '
				+ 'Address the cause first — resuming does not grant more budget, so a child that hit a cost or token limit '
				+ 'will stop again immediately unless the limit itself is raised.',
			input: z.object({
				agentId: agentIdSchema.describe('ID of the paused child agent, as given in the <child-paused> message'),
			}),
			execute: async (input, context) => {
				const target = context.sessionState.agents.get(input.agentId)
				if (!target) {
					return Err({ message: `No agent "${input.agentId}" in this session.`, recoverable: false })
				}
				if (target.parentId !== context.agentId) {
					return Err({ message: `Agent "${input.agentId}" is not your child — you can only resume agents you spawned.`, recoverable: false })
				}
				if (target.status !== 'paused' && target.status !== 'errored') {
					return Err({ message: `Agent "${input.agentId}" is ${target.status}, not paused — nothing to resume.`, recoverable: false })
				}

				const result = await ctx.self.resume({ agentId: input.agentId })
				if (!result.ok) {
					return Err({ message: result.error.message, recoverable: false })
				}
				return Ok(`Agent "${input.agentId}" resumed.`)
			},
		})

		const startTools = spawnableAgents.map((agentName) => {
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

		// An agent with nothing to spawn has no children to resume either.
		return spawnableAgents.length > 0 ? [...startTools, resumeTool] : []
	})
	.build()
