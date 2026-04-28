/**
 * User Chat Plugin - Three-level plugin architecture for user interaction
 *
 * Level 1 (Preset): UserChatPresetConfig with session-wide enable flag
 * Level 2 (Session): Plugin methods (askQuestion, tellUser, getMessages, sendMessage, answerQuestion)
 * Level 3 (Agent): Agent-specific configuration and tools
 *
 * Owns the `messages` state slice (chat messages for the UI)
 * and the full user message lifecycle via dequeue.
 */

import z from "zod/v4";
import { getAgentRole } from "~/core/agents/agent-roles.js";
import { type AgentId, agentIdSchema } from "~/core/agents/schema.js";
import { ValidationErrors } from "~/core/errors.js";
import { createEventsFactory } from "~/core/events/types.js";
import { estimateTokens, truncateByTokens } from "~/core/llm/tokens.js";
import { definePlugin } from "~/core/plugins/plugin-builder.js";
import { sessionIdSchema } from "~/core/sessions/schema.js";
import { getEntryAgentId } from "~/core/sessions/state.js";
import { createTool } from "~/core/tools/definition.js";
import { Err, Ok } from "~/lib/utils/result.js";
import { getUserCommunicationInstructions } from "~/prompts/base.js";
import {
	ASKING_QUESTIONS_SECTION,
	USER_COMMUNICATION_SECTION,
} from "./prompts.js";
import {
	type AskUserInputType,
	askUserInputTypeSchema,
	ChatMessageId,
	chatMessageIdSchema,
	generateChatMessageId,
} from "./schema.js";

// ============================================================================
// Events
// ============================================================================

export const userChatEvents = createEventsFactory({
	events: {
		user_question_asked: z.object({
			agentId: agentIdSchema,
			messageId: chatMessageIdSchema,
			question: z.string(),
			inputType: askUserInputTypeSchema,
		}),
		user_message_sent: z.object({
			agentId: agentIdSchema,
			messageId: chatMessageIdSchema,
			message: z.string(),
			format: z.enum(["text", "markdown"]),
		}),
		user_chat_message_received: z.object({
			agentId: agentIdSchema,
			messageId: chatMessageIdSchema,
			content: z.string(),
			timestamp: z.number(),
		}),
		user_chat_answer_received: z.object({
			agentId: agentIdSchema,
			messageId: chatMessageIdSchema,
			questionId: chatMessageIdSchema,
			answerValue: z.unknown(),
			timestamp: z.number(),
		}),
		user_chat_messages_consumed: z.object({
			agentId: agentIdSchema,
			messageIds: z.array(chatMessageIdSchema),
		}),
	},
});

export type UserQuestionAskedEvent =
	(typeof userChatEvents)["Events"]["user_question_asked"];
export type UserMessageSentEvent =
	(typeof userChatEvents)["Events"]["user_message_sent"];
export type UserChatMessageReceivedEvent =
	(typeof userChatEvents)["Events"]["user_chat_message_received"];
export type UserChatAnswerReceivedEvent =
	(typeof userChatEvents)["Events"]["user_chat_answer_received"];
export type UserChatMessagesConsumedEvent =
	(typeof userChatEvents)["Events"]["user_chat_messages_consumed"];

// For backwards compat
export { userChatEvents as userCommunicationEvents };

// ============================================================================
// Chat message types (state)
// ============================================================================

export interface UserChatMessage {
	type: "user_message";
	messageId: ChatMessageId;
	content: string;
	timestamp: number;
}

export interface AgentChatMessage {
	type: "agent_message";
	messageId: ChatMessageId;
	content: string;
	format: "text" | "markdown";
	timestamp: number;
}

export interface AskUserChatMessage {
	type: "ask_user";
	questionId: ChatMessageId;
	question: string;
	inputType: AskUserInputType;
	answered: boolean;
	answer?: unknown;
	timestamp: number;
}

export type ChatMessage =
	| UserChatMessage
	| AgentChatMessage
	| AskUserChatMessage;

// ============================================================================
// Pending inbound message (for dequeue)
// ============================================================================

export interface PendingInboundMessage {
	messageId: ChatMessageId;
	agentId: AgentId;
	content: string;
	timestamp: number;
	consumed: boolean;
	/** For answers: the question's message ID */
	questionId?: ChatMessageId;
	/** The answer value, only present for answers */
	answerValue?: unknown;
}

// ============================================================================
// State shape
// ============================================================================

export interface UserChatState {
	messages: ChatMessage[];
	counter: number;
	pendingInbound: PendingInboundMessage[];
}

// ============================================================================
// Config
// ============================================================================

/**
 * Session-wide user Chat configuration.
 */
export interface UserChatPresetConfig {
	/** Whether user Chat is enabled by default (default: true) */
	enabled?: boolean;
}

/**
 * User communication mode for agents.
 * - 'tool': Use tell_user/ask_user tools only (default)
 * - 'xml': Use <user> tags in response content
 * - 'both': Support both tools and <user> tags
 */
export type UserCommunicationMode = "tool" | "xml" | "both";

/**
 * Agent-specific user Chat configuration.
 */
export interface UserChatAgentConfig {
	/** Whether user Chat is enabled for this agent (default: true for entry agent) */
	enabled?: boolean;
	/** User communication mode. Default: 'tool' */
	userCommunication?: UserCommunicationMode;
}

// ============================================================================
// Tool schema
// ============================================================================

/**
 * Flat option schema for choice inputs (simpler for LLM).
 */
const askUserOptionSchema = z.object({
	value: z.string().describe("Option value (returned when selected)"),
	label: z.string().describe("Option label (displayed to user)"),
});

/**
 * Flat schema for ask_user tool - easier for LLM to understand than nested oneOf.
 * Transformed to AskUserInputType in the executor.
 */
const askUserFlatInputSchema = z.object({
	question: z
		.string()
		.describe(
			"Question to ask the user. One question per call, but you can call ask_user multiple times in a single response.",
		),
	inputType: z
		.enum(["text", "confirm", "rating", "single_choice", "multi_choice"])
		.describe(
			"Type of input: text (free text), confirm (yes/no), rating (numeric scale), single_choice or multi_choice (selection from options)",
		),
	// text options
	placeholder: z
		.string()
		.optional()
		.describe("Placeholder text for text input"),
	multiline: z.boolean().optional().describe("Allow multiline text input"),
	// rating options
	min: z
		.number()
		.int()
		.optional()
		.describe("Minimum value for rating (required when inputType=rating)"),
	max: z
		.number()
		.int()
		.optional()
		.describe("Maximum value for rating (required when inputType=rating)"),
	// choice options
	options: z
		.array(askUserOptionSchema)
		.optional()
		.describe(
			"Options array for single_choice or multi_choice (required for these types)",
		),
	// confirm options
	confirmLabel: z
		.string()
		.optional()
		.describe("Custom label for confirm button"),
	cancelLabel: z.string().optional().describe("Custom label for cancel button"),
});

type AskUserFlatInput = z.infer<typeof askUserFlatInputSchema>;

/**
 * Transform flat input to proper AskUserInputType discriminated union.
 */
function transformToAskUserInputType(
	input: AskUserFlatInput,
): AskUserInputType {
	switch (input.inputType) {
		case "text":
			return {
				type: "text",
				placeholder: input.placeholder,
				multiline: input.multiline,
			};
		case "confirm":
			return {
				type: "confirm",
				confirmLabel: input.confirmLabel,
				cancelLabel: input.cancelLabel,
			};
		case "rating":
			return {
				type: "rating",
				min: input.min ?? 1,
				max: input.max ?? 5,
			};
		case "single_choice":
			return {
				type: "single_choice",
				options: input.options ?? [],
			};
		case "multi_choice":
			return {
				type: "multi_choice",
				options: input.options ?? [],
			};
	}
}

// ============================================================================
// Constants
// ============================================================================

const MESSAGE_MAX_TOKENS = 200_000;
const MESSAGE_TRUNCATION_THRESHOLD = 10_000;
const MESSAGE_TRUNCATION_TARGET = 5_000;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Format pending inbound messages for the LLM.
 */
function formatPendingForLLM(pending: PendingInboundMessage[]): string {
	const parts: string[] = [];
	for (const msg of pending) {
		if (msg.questionId !== undefined) {
			parts.push(
				`[User answered question ${msg.questionId}]: ${JSON.stringify(msg.answerValue)}`,
			);
		} else {
			parts.push(`[User]: ${msg.content}`);
		}
	}
	return parts.join("\n");
}

// ============================================================================
// Plugin
// ============================================================================

export const userChatPlugin = definePlugin("user-chat")
	.pluginConfig<UserChatPresetConfig>()
	.events([userChatEvents])
	.state<UserChatState>({
		key: "messages",
		initial: (): UserChatState => ({
			messages: [],
			counter: 0,
			pendingInbound: [],
		}),
		reduce: (state, event) => {
			switch (event.type) {
				case "user_chat_message_received": {
					const userMessage: UserChatMessage = {
						type: "user_message",
						messageId: event.messageId,
						content: event.content,
						timestamp: event.timestamp,
					};
					const pending: PendingInboundMessage = {
						messageId: event.messageId,
						agentId: event.agentId,
						content: event.content,
						timestamp: event.timestamp,
						consumed: false,
					};
					return {
						messages: [...state.messages, userMessage],
						counter: state.counter + 1,
						pendingInbound: [...state.pendingInbound, pending],
					};
				}

				case "user_chat_answer_received": {
					// Update the question in messages as answered
					const updatedMessages = state.messages.map((msg) =>
						msg.type === "ask_user" && msg.questionId === event.questionId
							? { ...msg, answered: true, answer: event.answerValue }
							: msg,
					);
					const pending: PendingInboundMessage = {
						messageId: event.messageId,
						agentId: event.agentId,
						content: JSON.stringify(event.answerValue),
						timestamp: event.timestamp,
						consumed: false,
						questionId: event.questionId,
						answerValue: event.answerValue,
					};
					return {
						messages: updatedMessages,
						counter: state.counter + 1,
						pendingInbound: [...state.pendingInbound, pending],
					};
				}

				case "user_chat_messages_consumed": {
					const consumedSet = new Set(event.messageIds.map(String));
					return {
						...state,
						pendingInbound: state.pendingInbound.map((msg) =>
							consumedSet.has(String(msg.messageId)) &&
							msg.agentId === event.agentId
								? { ...msg, consumed: true }
								: msg,
						),
					};
				}

				case "user_question_asked": {
					const askMessage: AskUserChatMessage = {
						type: "ask_user",
						questionId: event.messageId,
						question: event.question,
						inputType: event.inputType,
						answered: false,
						timestamp: event.timestamp,
					};
					return {
						...state,
						messages: [...state.messages, askMessage],
						counter: state.counter + 1,
					};
				}

				case "user_message_sent": {
					const agentMessage: AgentChatMessage = {
						type: "agent_message",
						messageId: event.messageId,
						content: event.message,
						format: event.format,
						timestamp: event.timestamp,
					};
					return {
						...state,
						messages: [...state.messages, agentMessage],
						counter: state.counter + 1,
					};
				}

				default:
					return state;
			}
		},
	})
	.agentConfig<UserChatAgentConfig>()
	.notification("agentMessage", {
		schema: z.object({
			sessionId: sessionIdSchema,
			content: z.string(),
			format: z.enum(["text", "markdown"]),
			timestamp: z.number(),
		}),
	})
	.notification("askUser", {
		schema: z.object({
			sessionId: sessionIdSchema,
			questionId: z.string(),
			question: z.string(),
			inputType: askUserInputTypeSchema,
			timestamp: z.number(),
		}),
	})
	.method("askQuestion", {
		input: z.object({
			agentId: agentIdSchema,
			question: z.string(),
			inputType: askUserInputTypeSchema,
		}),
		output: z.object({
			messageId: z.string(),
		}),
		handler: async (ctx, input) => {
			const messageId = generateChatMessageId(ctx.pluginState.counter + 1);
			const timestamp = Date.now();
			await ctx.emitEvent(
				userChatEvents.create("user_question_asked", {
					agentId: input.agentId,
					messageId,
					question: input.question,
					inputType: input.inputType,
				}),
			);
			ctx.notify("askUser", {
				sessionId: ctx.sessionId,
				questionId: messageId,
				question: input.question,
				inputType: input.inputType,
				timestamp,
			});

			return Ok({ messageId });
		},
	})
	.method("tellUser", {
		input: z.object({
			agentId: agentIdSchema,
			message: z.string(),
			format: z.enum(["text", "markdown"]),
		}),
		output: z.object({
			messageId: z.string(),
		}),
		handler: async (ctx, input) => {
			const messageId = generateChatMessageId(ctx.pluginState.counter + 1);
			const timestamp = Date.now();
			await ctx.emitEvent(
				userChatEvents.create("user_message_sent", {
					agentId: input.agentId,
					messageId,
					message: input.message,
					format: input.format,
				}),
			);
			ctx.notify("agentMessage", {
				sessionId: ctx.sessionId,
				content: input.message,
				format: input.format,
				timestamp,
			});

			return Ok({ messageId });
		},
	})
	.method("sendMessage", {
		input: z.object({
			agentId: agentIdSchema.optional(),
			content: z.string(),
		}),
		output: z.object({
			messageId: chatMessageIdSchema,
		}),
		handler: async (ctx, input) => {
			const agentId = input.agentId ?? getEntryAgentId(ctx.sessionState);
			if (!agentId) {
				throw new Error("No agent available");
			}

			// Hard limit
			const tokenCount = estimateTokens(input.content);
			if (tokenCount > MESSAGE_MAX_TOKENS) {
				return Err(
					ValidationErrors.invalid(
						`Message too large: ~${tokenCount} tokens (max ${MESSAGE_MAX_TOKENS})`,
					),
				);
			}

			const messageId = generateChatMessageId(ctx.pluginState.counter + 1);

			// Soft truncation — save full content to file, pass truncated + reference
			let content = input.content;
			const truncation =
				tokenCount > MESSAGE_TRUNCATION_THRESHOLD
					? truncateByTokens(input.content, MESSAGE_TRUNCATION_TARGET)
					: null;
			if (truncation) {
				const filePath = `.user-messages/${messageId}.md`;
				await ctx.files.session.write(filePath, input.content);
				content = `${truncation.content}\n\n[Full message saved to: ${filePath} — use read_file to access it]`;
			}

			await ctx.emitEvent(
				userChatEvents.create("user_chat_message_received", {
					agentId: agentId,
					messageId,
					content,
					timestamp: Date.now(),
				}),
			);
			ctx.scheduleAgent(agentId);
			return Ok({ messageId });
		},
	})
	.method("answerQuestion", {
		input: z.object({
			agentId: agentIdSchema,
			questionId: chatMessageIdSchema,
			answer: z.unknown(),
		}),
		output: z.object({}),
		handler: async (ctx, input) => {
			const messageId = generateChatMessageId(ctx.pluginState.counter + 1);
			await ctx.emitEvent(
				userChatEvents.create("user_chat_answer_received", {
					agentId: input.agentId,
					messageId,
					questionId: input.questionId,
					answerValue: input.answer,
					timestamp: Date.now(),
				}),
			);
			ctx.scheduleAgent(input.agentId);
			return Ok({});
		},
	})
	.method("getMessages", {
		input: z.object({
			sessionId: z.string(),
		}),
		output: z.object({
			messages: z.array(z.unknown()),
		}),
		handler: async (ctx) => {
			return Ok({ messages: ctx.pluginState.messages });
		},
	})
	.dequeue({
		hasPendingMessages: (ctx) =>
			ctx.pluginState.pendingInbound.some(
				(m) => !m.consumed && m.agentId === ctx.agentId,
			),

		getPendingMessages: (ctx) => {
			const pending = ctx.pluginState.pendingInbound.filter(
				(m) => !m.consumed && m.agentId === ctx.agentId,
			);
			if (pending.length === 0) return null;
			return {
				messages: [{ role: "user", content: formatPendingForLLM(pending) }],
				token: pending.map((m) => m.messageId),
			};
		},

		markConsumed: async (ctx, token) => {
			await ctx.emitEvent(
				userChatEvents.create("user_chat_messages_consumed", {
					agentId: ctx.agentId,
					messageIds: token,
				}),
			);
		},
	})
	.hook("afterInference", async (ctx) => {
		const mode = ctx.pluginAgentConfig?.userCommunication;
		if (mode !== "xml" && mode !== "both") return null;

		const responseContent = ctx.response.content;
		if (!responseContent) return null;

		const userTagRegex = /<user>([\s\S]*?)<\/user>/g;
		let match: RegExpExecArray | null;
		let localCounter = ctx.pluginState.counter;
		while ((match = userTagRegex.exec(responseContent)) !== null) {
			const content = match[1].trim();
			if (!content) continue;
			localCounter++;
			const chatMessageId = generateChatMessageId(localCounter);
			await ctx.emitEvent(
				userChatEvents.create("user_message_sent", {
					agentId: ctx.agentId,
					messageId: chatMessageId,
					message: content,
					format: "text",
				}),
			);
			ctx.notify("agentMessage", {
				sessionId: ctx.sessionId,
				content,
				format: "text",
				timestamp: Date.now(),
			});
		}

		// Strip <user> tags from response content
		const cleanedContent = responseContent
			.replace(/<user>[\s\S]*?<\/user>/g, "")
			.trim();
		if (cleanedContent !== responseContent) {
			return {
				action: "modify",
				response: { ...ctx.response, content: cleanedContent || null },
			};
		}
		return null;
	})
	.systemPrompt((ctx) => {
		const enabled = ctx.pluginConfig.enabled !== false;
		const agentEnabled = ctx.pluginAgentConfig?.enabled !== false;
		if (!enabled || !agentEnabled) return null;

		const role = getAgentRole(ctx.agentState, ctx.sessionState);
		if (role !== "entry" && role !== "communicator") return null;

		return (
			USER_COMMUNICATION_SECTION +
			"\n\n" +
			ASKING_QUESTIONS_SECTION +
			getUserCommunicationInstructions(
				ctx.pluginAgentConfig?.userCommunication,
				true,
			)
		);
	})
	.tools((ctx) => {
		const enabled = ctx.pluginConfig.enabled !== false;
		if (!enabled) return [];

		const agentEnabled = ctx.pluginAgentConfig?.enabled !== false;
		if (!agentEnabled) return [];

		const role = getAgentRole(ctx.agentState, ctx.sessionState);
		if (role !== "entry" && role !== "communicator") return [];

		return [
			createTool({
				name: "tell_user",
				description:
					"Send a message to the user (async, in response will ONLY confirm sending).",
				input: z.object({
					message: z.string().describe("Message to send to the user"),
					format: z
						.enum(["text", "markdown"])
						.optional()
						.describe("Message format (text or markdown). Defaults to text."),
				}),
				execute: async (input, context) => {
					const format = input.format ?? "text";
					const result = await ctx.self.tellUser({
						agentId: context.agentId,
						message: input.message,
						format,
					});
					if (!result.ok)
						return Err({ message: result.error.message, recoverable: false });
					return Ok(
						JSON.stringify({
							messageId: result.value.messageId,
							status: "sent",
						}),
					);
				},
			}),

			createTool({
				name: "ask_user",
				description:
					"Ask the user a question. One question per call, but you can call ask_user multiple times in a single response. The response will arrive in your mailbox. Prefer single_choice/multi_choice/confirm when possible options are known; use text only when the answer is truly open-ended. (async, in response will ONLY confirm sending)",
				input: askUserFlatInputSchema,
				execute: async (input, context) => {
					const inputType = transformToAskUserInputType(input);
					const result = await ctx.self.askQuestion({
						agentId: context.agentId,
						question: input.question,
						inputType,
					});
					if (!result.ok)
						return Err({ message: result.error.message, recoverable: false });
					return Ok(
						JSON.stringify({
							messageId: result.value.messageId,
							status: "sent",
						}),
					);
				},
			}),
		];
	})
	.build();
