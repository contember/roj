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
import { selectPluginState } from "~/core/sessions/reducer.js";
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
			ordinals: z.array(z.number().int().positive()).optional(),
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
	ordinal: number;
	messageId: ChatMessageId;
	agentId: AgentId;
	/** Stable index into visible message history for user messages. */
	messageIndex?: number;
	/** For answers: the question's message ID */
	questionId?: ChatMessageId;
}

export interface PendingAnswerRecord {
	questionId: ChatMessageId;
	answerValue: unknown;
}

// ============================================================================
// State shape
// ============================================================================

export interface UserChatState {
	messages: ChatMessage[];
	counter: number;
	pendingInbound: PendingInboundMessage[];
	/** Immutable answer payloads retained only until dequeue consumption. */
	pendingAnswers?: Map<number, PendingAnswerRecord>;
	/** Highest reducer-assigned inbound occurrence. */
	nextInboundOrdinal?: number;
}

interface UserChatPluginContext {
	nextMessageSequence: number;
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
	allowAttachments: z
		.boolean()
		.optional()
		.describe(
			"Render a file-attach control alongside the text field (text inputType only). Use when the answer needs to come with a file the user already has on hand — logo, brand PDF, source docs, supporting screenshots. Uploaded files reach you the same way as drag-drop attachments in plain chat.",
		),
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
				allowAttachments: input.allowAttachments,
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

function findQuestion(
	messages: ChatMessage[],
	questionId: ChatMessageId,
): AskUserChatMessage | undefined {
	for (const message of messages) {
		if (message.type === "ask_user" && message.questionId === questionId) {
			return message;
		}
	}
	return undefined;
}

function findUserMessage(
	messages: ChatMessage[],
	messageId: ChatMessageId,
): UserChatMessage | undefined {
	for (const message of messages) {
		if (message.type === "user_message" && message.messageId === messageId) {
			return message;
		}
	}
	return undefined;
}

function messageSequence(messageId: ChatMessageId): number {
	const match = /^m(\d+)$/.exec(messageId);
	return match ? Number(match[1]) : 0;
}

function nextStateCounter(state: UserChatState, messageId: ChatMessageId): number {
	return Math.max(state.counter + 1, messageSequence(messageId));
}

function nextMessageSequence(state: UserChatState | undefined): number {
	if (!state) return 1;
	let highest = state.counter;
	for (const message of state.messages) {
		const messageId = message.type === "ask_user" ? message.questionId : message.messageId;
		highest = Math.max(highest, messageSequence(messageId));
	}
	for (const pending of state.pendingInbound) {
		highest = Math.max(highest, messageSequence(pending.messageId));
	}
	return highest + 1;
}

function reserveMessageSequence(context: UserChatPluginContext): number {
	const sequence = context.nextMessageSequence;
	context.nextMessageSequence++;
	return sequence;
}

/**
 * Format pending inbound messages for the LLM.
 */
function formatPendingForLLM(
	messages: ChatMessage[],
	pending: PendingInboundMessage[],
	pendingAnswers: ReadonlyMap<number, PendingAnswerRecord> | undefined,
): string {
	const parts: string[] = [];
	for (const msg of pending) {
		if (msg.questionId !== undefined) {
			const answer = pendingAnswers?.get(msg.ordinal);
			const answerValue = answer
				? answer.answerValue
				: findQuestion(messages, msg.questionId)?.answer;
			parts.push(
				`[User answered question ${msg.questionId}]: ${JSON.stringify(answerValue)}`,
			);
		} else {
			const indexedMessage = msg.messageIndex === undefined
				? undefined
				: messages[msg.messageIndex];
			const userMessage = indexedMessage?.type === "user_message"
				? indexedMessage
				: findUserMessage(messages, msg.messageId);
			if (userMessage) parts.push(`[User]: ${userMessage.content}`);
		}
	}
	return parts.join("\n");
}

// Some models (notably routed through OpenRouter — Gemini/Llama/Qwen) emit
// non-ASCII tool argument strings as double-escaped JSON: the wire form is
// `"\\u0159"`, which JSON.parse turns into a literal 6-char `ř` instead
// of `ř`. The user then sees raw escape sequences in their UI. Applied only
// to user-facing display fields (question, placeholder, labels, message body)
// — never to identifiers like `option.value` (must round-trip back to the LLM
// unchanged) or to code-bearing inputs of other tools.
function decodeUnicodeEscapes(value: string): string;
function decodeUnicodeEscapes(value: string | undefined): string | undefined;
function decodeUnicodeEscapes(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	if (!value.includes("\\u")) return value;
	return value.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
		String.fromCharCode(parseInt(hex, 16)),
	);
}

function decodeAskUserDisplayStrings(input: AskUserInputType): AskUserInputType {
	switch (input.type) {
		case "text":
			return { ...input, placeholder: decodeUnicodeEscapes(input.placeholder) };
		case "single_choice":
		case "multi_choice":
			return {
				...input,
				options: input.options.map((o) => ({
					...o,
					label: decodeUnicodeEscapes(o.label),
					description: decodeUnicodeEscapes(o.description),
				})),
			};
		case "confirm":
			return {
				...input,
				confirmLabel: decodeUnicodeEscapes(input.confirmLabel),
				cancelLabel: decodeUnicodeEscapes(input.cancelLabel),
			};
		case "rating":
			return input.labels
				? {
					...input,
					labels: {
						min: decodeUnicodeEscapes(input.labels.min),
						max: decodeUnicodeEscapes(input.labels.max),
					},
				}
				: input;
	}
}

// ============================================================================
// Plugin
// ============================================================================

export const userChatPlugin = definePlugin("user-chat")
	.order(60)
	.pluginConfig<UserChatPresetConfig>()
	.events([userChatEvents])
	.context(async (ctx): Promise<UserChatPluginContext> => ({
		nextMessageSequence: nextMessageSequence(
			selectPluginState<UserChatState>(ctx.sessionState, "messages"),
		),
	}))
	.state<UserChatState>({
		key: "messages",
		initial: (): UserChatState => ({
			messages: [],
			counter: 0,
			pendingInbound: [],
			pendingAnswers: new Map(),
			nextInboundOrdinal: 0,
		}),
		reduce: (state, event) => {
			switch (event.type) {
				case "user_chat_message_received": {
					const ordinal = (state.nextInboundOrdinal ?? 0) + 1;
					const userMessage: UserChatMessage = {
						type: "user_message",
						messageId: event.messageId,
						content: event.content,
						timestamp: event.timestamp,
					};
					const pending: PendingInboundMessage = {
						ordinal,
						messageId: event.messageId,
						agentId: event.agentId,
						messageIndex: state.messages.length,
					};
					return {
						messages: [...state.messages, userMessage],
						counter: nextStateCounter(state, event.messageId),
						pendingInbound: [...state.pendingInbound, pending],
						pendingAnswers: state.pendingAnswers,
						nextInboundOrdinal: ordinal,
					};
				}

				case "user_chat_answer_received": {
					const ordinal = (state.nextInboundOrdinal ?? 0) + 1;
					// Update the question in messages as answered
					const updatedMessages = state.messages.map((msg) =>
						msg.type === "ask_user" && msg.questionId === event.questionId
							? { ...msg, answered: true, answer: event.answerValue }
							: msg,
					);
					const pending: PendingInboundMessage = {
						ordinal,
						messageId: event.messageId,
						agentId: event.agentId,
						questionId: event.questionId,
					};
					const pendingAnswers = new Map(state.pendingAnswers ?? []);
					pendingAnswers.set(ordinal, {
						questionId: event.questionId,
						answerValue: event.answerValue,
					});
					return {
						messages: updatedMessages,
						counter: nextStateCounter(state, event.messageId),
						pendingInbound: [...state.pendingInbound, pending],
						pendingAnswers,
						nextInboundOrdinal: ordinal,
					};
				}

				case "user_chat_messages_consumed": {
					const consumedOrdinals = new Set<number>();
					if (event.ordinals) {
						for (const ordinal of event.ordinals) consumedOrdinals.add(ordinal);
					} else {
						const remainingById = new Map<string, number>();
						for (const messageId of event.messageIds) {
							const key = String(messageId);
							remainingById.set(key, (remainingById.get(key) ?? 0) + 1);
						}
						for (const pending of state.pendingInbound) {
							if (pending.agentId !== event.agentId) continue;
							const key = String(pending.messageId);
							const remaining = remainingById.get(key) ?? 0;
							if (remaining === 0) continue;
							consumedOrdinals.add(pending.ordinal);
							remainingById.set(key, remaining - 1);
						}
					}
					const pendingAnswers = new Map(state.pendingAnswers ?? []);
					for (const pending of state.pendingInbound) {
						if (
							pending.agentId === event.agentId &&
							consumedOrdinals.has(pending.ordinal)
						) {
							pendingAnswers.delete(pending.ordinal);
						}
					}
					return {
						...state,
						pendingInbound: state.pendingInbound.filter(
							(msg) =>
								msg.agentId !== event.agentId ||
								!consumedOrdinals.has(msg.ordinal),
						),
						pendingAnswers,
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
						counter: nextStateCounter(state, event.messageId),
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
						counter: nextStateCounter(state, event.messageId),
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
			const messageId = generateChatMessageId(
				reserveMessageSequence(ctx.pluginContext),
			);
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
			const messageId = generateChatMessageId(
				reserveMessageSequence(ctx.pluginContext),
			);
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

			const messageId = generateChatMessageId(
				reserveMessageSequence(ctx.pluginContext),
			);

			// Soft truncation — save full content to file, pass truncated + reference
			let content = input.content;
			const truncation =
				tokenCount > MESSAGE_TRUNCATION_THRESHOLD
					? truncateByTokens(input.content, MESSAGE_TRUNCATION_TARGET)
					: null;
			if (truncation) {
				const filePath = `.user-messages/${messageId}.md`;
				const writeResult = await ctx.files.session.write(
					filePath,
					input.content,
				);
				if (!writeResult.ok) {
					// Without the full copy on disk the truncated message would silently lose content.
					return Err(
						ValidationErrors.invalid(
							`Failed to store full message: ${writeResult.error}`,
						),
					);
				}
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
			// A retried batch resubmits answers that already landed; the agent must see one.
			const asked = ctx.pluginState.messages.find(
				(msg) => msg.type === "ask_user" && msg.questionId === input.questionId,
			);
			if (asked?.type === "ask_user" && asked.answered) return Ok({});

			const messageId = generateChatMessageId(
				reserveMessageSequence(ctx.pluginContext),
			);
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
			ctx.pluginState.pendingInbound.some((m) => m.agentId === ctx.agentId),

		getPendingMessages: (ctx) => {
			const pending = ctx.pluginState.pendingInbound.filter(
				(m) => m.agentId === ctx.agentId,
			);
			if (pending.length === 0) return null;
			return {
				messages: [
					{
						role: "user",
						content: formatPendingForLLM(
							ctx.pluginState.messages,
							pending,
							ctx.pluginState.pendingAnswers,
						),
					},
				],
				token: pending.map((message) => ({
					messageId: message.messageId,
					ordinal: message.ordinal,
				})),
			};
		},

		markConsumed: async (ctx, token) => {
			await ctx.emitEvent(
				userChatEvents.create("user_chat_messages_consumed", {
					agentId: ctx.agentId,
					messageIds: token.map((item) => item.messageId),
					ordinals: token.map((item) => item.ordinal),
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
		while ((match = userTagRegex.exec(responseContent)) !== null) {
			const content = match[1].trim();
			if (!content) continue;
			const chatMessageId = generateChatMessageId(
				reserveMessageSequence(ctx.pluginContext),
			);
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
						message: decodeUnicodeEscapes(input.message),
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
						question: decodeUnicodeEscapes(input.question),
						inputType: decodeAskUserDisplayStrings(inputType),
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
