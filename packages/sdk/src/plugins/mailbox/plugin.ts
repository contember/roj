/**
 * Mailbox Plugin - Inter-agent communication via message passing
 *
 * Level 1 (Preset): Empty config (mailbox is always enabled)
 * Level 2 (Session): Events factory + state slice + methods + tools
 * Level 3 (Agent): send_message tool for communication
 */

import z from "zod/v4";
import { getAgentRole } from "~/core/agents/agent-roles.js";
import { type AgentId, agentIdSchema } from "~/core/agents/schema.js";
import { ValidationErrors } from "~/core/errors.js";
import { definePlugin } from "~/core/plugins/plugin-builder.js";
import { createTool } from "~/core/tools/definition.js";
import type { ToolError } from "~/core/tools/index.js";
import { Err, Ok } from "~/lib/utils/result.js";
import { canCommunicateWith, getCommunicableAgents } from "./helpers.js";
import {
	CHILD_REPORTING_SECTION,
	COMMUNICATOR_FLOW_SECTION,
	ENTRY_ROLE_SECTION,
	formatMailboxForLLM,
	ORCHESTRATOR_REPORTING_SECTION,
} from "./prompts.js";
import {
	getAgentUnconsumedMailbox,
	getNextMessageSeq,
	type MailboxPluginState,
} from "./query.js";
import { generateMessageId, type MessageId } from "./schema.js";
import type { MailboxMessage } from "./schema.js";
import { mailboxEvents } from "./state.js";

/**
 * Session-wide mailbox configuration.
 */
export type MailboxPresetConfig = {};

/**
 * Agent-specific mailbox configuration.
 */
export interface MailboxAgentConfig {
	/** If true, agent sends a completion message to its parent when it has no more work. */
	sendCompletionMessage?: boolean;
}

export const mailboxPlugin = definePlugin("mailbox")
	.pluginConfig<MailboxPresetConfig>()
	.agentConfig<MailboxAgentConfig>()
	.events([mailboxEvents])
	.state<MailboxPluginState>({
		key: "mailbox",
		initial: (): MailboxPluginState => ({
			agentMailboxes: new Map(),
		}),
		reduce: (state, event) => {
			switch (event.type) {
				case "mailbox_message": {
					const agentMailbox = state.agentMailboxes.get(event.toAgentId) ?? [];
					const newMailboxes = new Map(state.agentMailboxes);
					newMailboxes.set(event.toAgentId, [...agentMailbox, event.message]);
					return {
						...state,
						agentMailboxes: newMailboxes,
					};
				}

				case "mailbox_consumed": {
					const mailbox = state.agentMailboxes.get(event.agentId);
					if (!mailbox) return state;
					const consumedSet = new Set(event.messageIds);
					const newMailboxes = new Map(state.agentMailboxes);
					newMailboxes.set(
						event.agentId,
						mailbox.map((m) =>
							consumedSet.has(m.id) ? { ...m, consumed: true } : m,
						),
					);
					return { ...state, agentMailboxes: newMailboxes };
				}

				default:
					return state;
			}
		},
	})
	.method("send", {
		input: z.object({
			fromAgentId: agentIdSchema.optional(),
			toAgentId: agentIdSchema,
			content: z.string(),
			debug: z.boolean().optional(),
		}),
		output: z.object({ messageId: z.string() }),
		handler: async (ctx, input) => {
			const { toAgentId, content } = input;

			if (input.debug) {
				// Debug messages bypass communication validation
				const messageId = generateMessageId(getNextMessageSeq(ctx.pluginState));
				await ctx.emitEvent(
					mailboxEvents.create("mailbox_message", {
						toAgentId,
						message: {
							id: messageId,
							from: "debug",
							content,
							timestamp: Date.now(),
							consumed: false,
						},
					}),
				);
				ctx.scheduleAgent(toAgentId);
				return Ok({ messageId });
			}

			const fromAgentId = input.fromAgentId;
			if (!fromAgentId) {
				return Err(
					ValidationErrors.invalid(
						"fromAgentId is required for non-debug messages",
					),
				);
			}

			// Validate that the target agent is allowed
			if (!canCommunicateWith(ctx.sessionState, fromAgentId, toAgentId)) {
				const allowed = getCommunicableAgents(ctx.sessionState, fromAgentId);
				const allowedStr = allowed.length > 0 ? allowed.join(", ") : "none";
				return Err(
					ValidationErrors.invalid(
						`Cannot send message to agent ${toAgentId}. You can only communicate with your parent or children. Allowed agents: ${allowedStr}`,
					),
				);
			}

			const messageId = generateMessageId(getNextMessageSeq(ctx.pluginState));
			const now = Date.now();

			await ctx.emitEvent(
				mailboxEvents.create("mailbox_message", {
					toAgentId,
					message: {
						id: messageId,
						from: fromAgentId,
						content,
						timestamp: now,
						consumed: false,
					},
				}),
			);

			ctx.scheduleAgent(toAgentId);

			return Ok({ messageId });
		},
	})
	.dequeue({
		hasPendingMessages: (ctx) => {
			return getAgentUnconsumedMailbox(ctx.pluginState, ctx.agentId).length > 0;
		},

		getPendingMessages: (ctx) => {
			const unconsumed = getAgentUnconsumedMailbox(
				ctx.pluginState,
				ctx.agentId,
			);
			if (unconsumed.length === 0) return null;
			return {
				messages: [
					{
						role: "user",
						content: formatMailboxForLLM(unconsumed, Date.now()),
						sourceMessageIds: unconsumed.map((m: MailboxMessage) => m.id),
					},
				],
				token: unconsumed.map((m: MailboxMessage) => m.id),
			};
		},

		markConsumed: async (ctx, token) => {
			await ctx.emitEvent(
				mailboxEvents.create("mailbox_consumed", {
					agentId: ctx.agentId,
					messageIds: token,
				}),
			);
		},
	})
	.hook("onComplete", async (ctx) => {
		if (!ctx.agentState.parentId) return null;
		if (!ctx.pluginAgentConfig?.sendCompletionMessage) return null;

		await ctx.self.send({
			fromAgentId: ctx.agentId,
			toAgentId: ctx.agentState.parentId,
			content: "Task completed.",
		});
		return null;
	})
	.hook("onError", async (ctx) => {
		if (!ctx.agentState.parentId) return null;

		await ctx.self.send({
			fromAgentId: ctx.agentId,
			toAgentId: ctx.agentState.parentId,
			content: `Agent encountered an error: ${ctx.error}`,
		});
		return null;
	})
	.systemPrompt((ctx) => {
		const role = getAgentRole(ctx.agentState, ctx.sessionState);
		switch (role) {
			case "child":
				return CHILD_REPORTING_SECTION;
			case "orchestrator":
				return ORCHESTRATOR_REPORTING_SECTION;
			case "communicator":
				return COMMUNICATOR_FLOW_SECTION;
			case "entry":
				return ENTRY_ROLE_SECTION;
		}
	})
	.tools((ctx) => {
		return [
			createTool({
				name: "send_message",
				description:
					'Send a message to another agent. Use to: "parent" to report back to your parent agent, or a specific agent ID for child agents. (async, in response will ONLY confirm sending)',
				input: z.object({
					to: z
						.string()
						.describe(
							'Target agent ID, or "parent" to send to your parent agent',
						),
					message: z.string().describe("Message content to send"),
				}),
				execute: async (input, context) => {
					let toAgentId = input.to as AgentId;

					// Resolve "parent" alias to actual parentId
					if (toAgentId === ("parent" as AgentId)) {
						const agentState = ctx.sessionState.agents.get(context.agentId);
						if (!agentState?.parentId) {
							return Err({
								message:
									'Cannot send message to "parent": this agent has no parent.',
								recoverable: false,
							} satisfies ToolError);
						}
						toAgentId = agentState.parentId;
					}

					const result = await ctx.self.send({
						fromAgentId: context.agentId,
						toAgentId,
						content: input.message,
					});

					if (!result.ok)
						return Err({ message: result.error.message, recoverable: false });

					return Ok(
						`Message sent to ${input.to} (message ID: ${result.value.messageId}).`,
					);
				},
			}),
		];
	})
	.build();
