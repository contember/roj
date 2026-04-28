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
import { agentEvents } from '~/core/agents/state.js'
import { AgentErrors, ValidationErrors } from '~/core/errors.js'
import { definePlugin } from '~/core/plugins/index.js'
import { getNextAgentSeq } from '~/core/sessions/state.js'
import { createTool } from '~/core/tools/definition.js'
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
	.systemPrompt(() => {
		return `## Working with Child Agents

- **New task** → spawn a new agent using \`start_<agent_name>\`. You will receive the agent's ID in the result — use it with \`send_message\` for follow-up communication.
- **Follow-up on an existing task** → send a message to the existing agent via \`send_message\` with the agent's ID. Do NOT spawn a new agent for feedback, corrections, or additional instructions on a task already assigned.
- Spawned agents communicate back to you via \`send_message\`. Check your incoming messages for their results and progress updates.`
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
