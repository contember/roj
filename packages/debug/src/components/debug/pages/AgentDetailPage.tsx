import type {
	AssistantConversationMessageView,
	ConversationMessageView,
	ToolCallView,
	ToolConversationMessageView,
} from "@roj-ai/shared";
import { AgentId } from "@roj-ai/shared";
import { type FormEvent, useCallback, useMemo, useState } from "react";
import { api, unwrap } from "@roj-ai/client";
import { useAgentDetail, useEventStore } from "../../../stores/event-store";
import { formatDuration } from "../../../utils/format";
import {
	DebugLink,
	useDebugParams,
	useDebugSessionId,
} from "../DebugNavigation";

function formatTime(ts: number | undefined): string | null {
	if (ts === undefined) return null;
	return new Date(ts).toLocaleTimeString();
}

function Timestamp({ value }: { value: number | undefined }) {
	const formatted = formatTime(value);
	if (!formatted) return null;
	return (
		<span className="text-[10px] text-gray-400 tabular-nums ml-auto shrink-0">
			{formatted}
		</span>
	);
}

function CopyButton({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);

	const handleCopy = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			navigator.clipboard.writeText(text);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		},
		[text],
	);

	return (
		<button
			type="button"
			onClick={handleCopy}
			className="absolute top-1.5 right-1.5 opacity-0 group-hover/code:opacity-100 transition-opacity p-1 rounded bg-white/80 hover:bg-gray-100 border border-gray-200 cursor-pointer"
			title="Copy to clipboard"
		>
			{copied ? (
				<svg
					className="w-3.5 h-3.5 text-green-600"
					fill="none"
					stroke="currentColor"
					viewBox="0 0 24 24"
				>
					<path
						strokeLinecap="round"
						strokeLinejoin="round"
						strokeWidth={2}
						d="M5 13l4 4L19 7"
					/>
				</svg>
			) : (
				<svg
					className="w-3.5 h-3.5 text-gray-500"
					fill="none"
					stroke="currentColor"
					viewBox="0 0 24 24"
				>
					<path
						strokeLinecap="round"
						strokeLinejoin="round"
						strokeWidth={2}
						d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
					/>
				</svg>
			)}
		</button>
	);
}

function CodeBlock({
	children,
	variant = "default",
}: {
	children: string;
	variant?: "default" | "success" | "error";
}) {
	const styles = {
		default: "bg-gray-50 border-gray-200 text-gray-800",
		success: "bg-green-50 border-green-200 text-gray-800",
		error: "bg-red-50 border-red-200 text-red-800",
	};
	return (
		<div className="relative group/code">
			<pre
				className={`p-2 rounded-lg border overflow-x-auto text-[11px] font-mono whitespace-pre-wrap break-words ${styles[variant]}`}
			>
				{children}
			</pre>
			<CopyButton text={children} />
		</div>
	);
}

export function AgentDetailPage({
	agentId: agentIdProp,
}: {
	agentId?: string;
} = {}) {
	const { agentId: agentIdParam } = useDebugParams<{ agentId: string }>();
	const agentId = agentIdProp ?? agentIdParam ?? "";
	const sessionId = useDebugSessionId();

	const detail = useAgentDetail(AgentId(agentId));
	const isLoading = useEventStore((s) => s.isLoading);

	const handleRewind = useCallback(
		async (messageIndex: number) => {
			if (!sessionId || !agentId) return;
			unwrap(
				await api.call("agents.rewind", {
					sessionId,
					agentId: AgentId(agentId),
					messageIndex,
				}),
			);
		},
		[sessionId, agentId],
	);

	if (isLoading) {
		return <div className="text-gray-400 text-sm">Loading...</div>;
	}

	if (!detail) {
		return <div className="text-gray-400 text-sm">Agent not found</div>;
	}

	const { counters } = detail;

	return (
		<div className="text-sm">
			{/* Two-column layout */}
			<div className="flex gap-5 items-start">
				{/* Left column - Conversation (2/3) */}
				<div className="flex-[2] min-w-0 space-y-5">
					{/* Conversation History Section */}
					<CollapsibleSection
						title="Conversation History"
						count={detail.conversationHistory.length}
						defaultOpen
					>
						{detail.conversationHistory.length === 0 ? (
							<div className="text-gray-400">Empty</div>
						) : (
							<ConversationGroups
								messages={detail.conversationHistory}
								onRewind={handleRewind}
							/>
						)}
					</CollapsibleSection>
				</div>

				{/* Right column - Sidebar (1/3) */}
				<div className="flex-1 min-w-0 space-y-4 sticky top-0">
					{/* Agent Header Card */}
					<div className="bg-white rounded-2xl shadow-card p-4">
						<div className="flex items-center gap-3 mb-4">
							<div className="w-9 h-9 rounded-xl bg-accent-peri/15 flex items-center justify-center shrink-0">
								<svg
									className="w-4.5 h-4.5 text-accent-peri"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={1.5}
										d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
									/>
								</svg>
							</div>
							<div className="flex-1 min-w-0">
								<div className="font-bold text-gray-900">
									{detail.definitionName}
								</div>
								<div className="text-[11px] text-gray-400 font-mono truncate">
									{detail.id}
								</div>
							</div>
							<StatusBadge status={detail.status} />
						</div>

						{detail.parentId && (
							<div className="text-[11px] text-gray-400 mb-3">
								Parent:{" "}
								<DebugLink
									to={`agents/${detail.parentId}`}
									className="text-accent-peri hover:underline font-mono"
								>
									{detail.parentId.slice(0, 12)}...
								</DebugLink>
							</div>
						)}

						{detail.pauseReason && (
							<div className="bg-red-50 border border-red-200 rounded-xl px-3 py-2 mb-3 flex items-center gap-2">
								<div className="w-2 h-2 rounded-full bg-red-500 shrink-0" />
								<span className="text-[11px] font-semibold text-red-700 flex-1">
									Paused
									{detail.pauseMessage
										? `: ${detail.pauseMessage}`
										: ` (${detail.pauseReason})`}
								</span>
								<ResumeAgentButton sessionId={sessionId} agentId={agentId!} />
							</div>
						)}

						{/* Counters Grid */}
						<div className="grid grid-cols-2 gap-2">
							<CounterItem label="Inferences" value={counters.inferenceCount} />
							<CounterItem label="Tool Calls" value={counters.toolCallCount} />
							<CounterItem label="Spawned" value={counters.spawnedAgentCount} />
							<CounterItem
								label="Messages"
								value={counters.messagesSentCount}
							/>
						</div>

						{/* Cost */}
						{detail.cost > 0 && (
							<div className="mt-2 bg-emerald-50 rounded-xl px-3 py-2.5 border border-emerald-100 flex items-center gap-2">
								<svg
									className="w-4 h-4 text-emerald-600 shrink-0"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={1.5}
										d="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
									/>
								</svg>
								<span className="text-[10px] text-emerald-600 uppercase tracking-wider font-medium">
									Cost
								</span>
								<span className="ml-auto text-sm font-bold tabular-nums text-emerald-700">
									${detail.cost.toFixed(4)}
								</span>
							</div>
						)}
					</div>

					{/* Pending Tool Calls */}
					<CollapsibleSection
						title="Pending Tool Calls"
						count={detail.pendingToolCalls.length}
						warnIfPositive
						defaultOpen={detail.pendingToolCalls.length > 0}
					>
						{detail.pendingToolCalls.length === 0 ? (
							<div className="text-gray-400">None</div>
						) : (
							<div className="space-y-2">
								{detail.pendingToolCalls.map((tool) => (
									<ToolCallCard key={tool.id} tool={tool} />
								))}
							</div>
						)}
					</CollapsibleSection>

					{/* Mailbox */}
					<CollapsibleSection
						title="Mailbox"
						count={detail.mailbox.length}
						defaultOpen={detail.mailbox.some((m) => !m.consumed)}
					>
						{detail.mailbox.length === 0 ? (
							<div className="text-gray-400">Empty</div>
						) : (
							<div className="space-y-2">
								{detail.mailbox.map((msg) => (
									<div
										key={msg.id}
										className={`rounded-xl px-3 py-2.5 border ${
											msg.consumed
												? "bg-gray-50 border-gray-100"
												: "bg-amber-50 border-amber-200"
										}`}
									>
										<div className="flex items-center gap-2 text-[11px] text-gray-400 mb-1.5 flex-wrap">
											<span className="font-medium">From:</span>
											{msg.from !== "user" &&
											msg.from !== "orchestrator" &&
											msg.from !== "communicator" ? (
												<DebugLink
													to={`agents/${msg.from}`}
													className="text-accent-peri hover:underline font-mono"
												>
													{msg.from.slice(0, 8)}...
												</DebugLink>
											) : (
												<span className="font-semibold text-gray-500">
													{msg.from}
												</span>
											)}
											{msg.consumed && (
												<span className="text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full font-medium">
													consumed
												</span>
											)}
											<span className="text-[10px] text-gray-400 tabular-nums ml-auto">
												{new Date(msg.timestamp).toLocaleTimeString()}
											</span>
										</div>
										<div className="whitespace-pre-wrap break-words text-gray-700 text-[12px] leading-relaxed">
											{msg.content}
										</div>
									</div>
								))}
							</div>
						)}
					</CollapsibleSection>

					{/* Loaded Skills */}
					{detail.loadedSkills.length > 0 && (
						<CollapsibleSection
							title="Loaded Skills"
							count={detail.loadedSkills.length}
							defaultOpen={false}
						>
							<div className="flex flex-wrap gap-1.5">
								{detail.loadedSkills.map((skill) => (
									<div
										key={skill.id}
										className="bg-accent-peri/10 text-gray-700 px-2 py-0.5 rounded-full text-[11px] font-medium"
									>
										{skill.name}
										<span className="text-gray-400 ml-1">
											{formatDuration(Date.now() - skill.loadedAt)} ago
										</span>
									</div>
								))}
							</div>
						</CollapsibleSection>
					)}

					{/* Typed Input */}
					{detail.typedInput !== undefined && (
						<CollapsibleSection title="Typed Input" defaultOpen={false}>
							<pre className="bg-gray-50 rounded-xl px-3 py-2.5 text-[11px] font-mono overflow-x-auto text-gray-700">
								{JSON.stringify(detail.typedInput, null, 2)}
							</pre>
						</CollapsibleSection>
					)}

					{/* Send Debug Message */}
					<SendMessageForm sessionId={sessionId} agentId={agentId!} />
				</div>
			</div>
		</div>
	);
}

// ============================================================================
// CollapsibleSection
// ============================================================================

function CollapsibleSection({
	title,
	count,
	warnIfPositive,
	defaultOpen = true,
	children,
}: {
	title: string;
	count?: number;
	warnIfPositive?: boolean;
	defaultOpen?: boolean;
	children: React.ReactNode;
}) {
	const [open, setOpen] = useState(defaultOpen);
	const isWarning = warnIfPositive && count !== undefined && count > 0;

	return (
		<div className="bg-white rounded-2xl shadow-card overflow-hidden">
			<button
				type="button"
				onClick={() => setOpen(!open)}
				className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-gray-50 transition-colors cursor-pointer"
			>
				<svg
					className={`w-3.5 h-3.5 text-gray-400 transition-transform ${open ? "rotate-90" : ""}`}
					fill="none"
					stroke="currentColor"
					viewBox="0 0 24 24"
				>
					<path
						strokeLinecap="round"
						strokeLinejoin="round"
						strokeWidth={2}
						d="M9 5l7 7-7 7"
					/>
				</svg>
				<span className="text-sm font-semibold text-gray-900">{title}</span>
				{count !== undefined && (
					<span
						className={`text-[11px] px-2 py-0.5 rounded-full font-medium tabular-nums ${
							isWarning
								? "bg-amber-100 text-amber-700"
								: "bg-gray-100 text-gray-500"
						}`}
					>
						{count}
					</span>
				)}
			</button>
			{open && <div className="px-4 pb-4">{children}</div>}
		</div>
	);
}

// ============================================================================
// CounterItem
// ============================================================================

const counterIcons: Record<string, React.ReactNode> = {
	Inferences: (
		<svg
			className="w-3.5 h-3.5"
			fill="none"
			stroke="currentColor"
			viewBox="0 0 24 24"
		>
			<path
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={1.5}
				d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z"
			/>
		</svg>
	),
	"Tool Calls": (
		<svg
			className="w-3.5 h-3.5"
			fill="none"
			stroke="currentColor"
			viewBox="0 0 24 24"
		>
			<path
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={1.5}
				d="M11.42 15.17l-5.1-5.1a1.5 1.5 0 010-2.12l.88-.88a1.5 1.5 0 012.12 0l2.83 2.83 5.66-5.66a1.5 1.5 0 012.12 0l.88.88a1.5 1.5 0 010 2.12l-7.07 7.07a1.5 1.5 0 01-2.12-.14z"
			/>
		</svg>
	),
	Spawned: (
		<svg
			className="w-3.5 h-3.5"
			fill="none"
			stroke="currentColor"
			viewBox="0 0 24 24"
		>
			<path
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={1.5}
				d="M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z"
			/>
		</svg>
	),
	Messages: (
		<svg
			className="w-3.5 h-3.5"
			fill="none"
			stroke="currentColor"
			viewBox="0 0 24 24"
		>
			<path
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={1.5}
				d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z"
			/>
		</svg>
	),
};

function CounterItem({ label, value }: { label: string; value: number }) {
	return (
		<div className="bg-gray-50 rounded-xl px-3 py-2.5 border border-gray-100">
			<div className="flex items-center gap-1.5 mb-1">
				<span className="text-gray-400">{counterIcons[label]}</span>
				<span className="text-[10px] text-gray-400 uppercase tracking-wider font-medium">
					{label}
				</span>
			</div>
			<div className="text-lg font-bold tabular-nums text-gray-900">
				{value}
			</div>
		</div>
	);
}

// ============================================================================
// ToolCallCard
// ============================================================================

function ToolCallCard({ tool }: { tool: ToolCallView }) {
	const [expanded, setExpanded] = useState(false);

	return (
		<div className="rounded-xl border border-gray-100 bg-gray-50 overflow-hidden">
			<button
				type="button"
				onClick={() => setExpanded(!expanded)}
				className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-gray-100 transition-colors cursor-pointer"
			>
				<ToolStatusDot status={tool.status} />
				<span className="font-mono font-medium text-sm text-gray-900">
					{tool.name}
				</span>
				<ToolStatusBadge status={tool.status} />
				<span className="text-[10px] text-gray-400 font-mono ml-auto">
					{tool.id.slice(0, 12)}
				</span>
				<svg
					className={`w-3 h-3 text-gray-400 transition-transform shrink-0 ${expanded ? "rotate-90" : ""}`}
					fill="none"
					stroke="currentColor"
					viewBox="0 0 24 24"
				>
					<path
						strokeLinecap="round"
						strokeLinejoin="round"
						strokeWidth={2}
						d="M9 5l7 7-7 7"
					/>
				</svg>
			</button>
			{expanded && (
				<div className="px-3 pb-3 space-y-2 border-t border-gray-100">
					{tool.input !== undefined && (
						<div className="mt-2">
							<div className="text-[10px] text-gray-500 uppercase tracking-wider font-medium mb-1">
								Input
							</div>
							<CodeBlock>{JSON.stringify(tool.input, null, 2)}</CodeBlock>
						</div>
					)}
					{tool.result !== undefined && (
						<div>
							<div className="text-[10px] text-green-700 uppercase tracking-wider font-medium mb-1">
								Result
							</div>
							<CodeBlock variant="success">
								{typeof tool.result === "string"
									? tool.result
									: JSON.stringify(tool.result, null, 2)}
							</CodeBlock>
						</div>
					)}
					{tool.error && (
						<div>
							<div className="text-[10px] text-red-700 uppercase tracking-wider font-medium mb-1">
								Error
							</div>
							<CodeBlock variant="error">{tool.error}</CodeBlock>
						</div>
					)}
				</div>
			)}
		</div>
	);
}

// ============================================================================
// Conversation Grouping
// ============================================================================

interface ToolInteraction {
	call: NonNullable<AssistantConversationMessageView["toolCalls"]>[number];
	response?: ToolConversationMessageView;
}

type ConversationGroup =
	| { type: "message"; message: ConversationMessageView; messageIndex: number }
	| {
			type: "assistant-with-tools";
			assistantMessage: AssistantConversationMessageView;
			toolInteractions: ToolInteraction[];
			messageIndex: number;
	  };

function groupConversation(
	messages: ConversationMessageView[],
): ConversationGroup[] {
	const groups: ConversationGroup[] = [];
	let i = 0;

	while (i < messages.length) {
		const msg = messages[i];

		if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
			const toolResponses = new Map<string, ToolConversationMessageView>();
			let j = i + 1;
			while (j < messages.length) {
				const nextMsg = messages[j];
				if (nextMsg.role !== "tool") break;
				toolResponses.set(nextMsg.toolCallId, nextMsg);
				j++;
			}

			groups.push({
				type: "assistant-with-tools",
				assistantMessage: msg,
				toolInteractions: msg.toolCalls.map((tc) => ({
					call: tc,
					response: toolResponses.get(tc.id),
				})),
				messageIndex: i,
			});
			i = j;
		} else {
			groups.push({ type: "message", message: msg, messageIndex: i });
			i++;
		}
	}

	return groups;
}

function ConversationGroups({
	messages,
	onRewind,
}: {
	messages: ConversationMessageView[];
	onRewind?: (messageIndex: number) => void;
}) {
	const groups = useMemo(() => groupConversation(messages), [messages]);

	// Compute previous assistant message's total input for cache validation.
	// promptTokens (= Anthropic input_tokens) is the TOTAL input including cached/cache-write portions.
	const prevTotalInputs = useMemo(() => {
		const result: Array<number | undefined> = [];
		let prevTotal: number | undefined;
		for (const group of groups) {
			result.push(prevTotal);
			if (group.type === "assistant-with-tools") {
				const msg = group.assistantMessage;
				if (msg.promptTokens !== undefined) {
					prevTotal = msg.promptTokens;
				}
			}
		}
		return result;
	}, [groups]);

	return (
		<div className="space-y-3">
			{groups.map((group, idx) => {
				if (group.type === "message") {
					return <ConversationMessage key={idx} msg={group.message} />;
				}
				return (
					<AssistantToolGroup
						key={idx}
						group={group}
						expectedCacheRead={prevTotalInputs[idx]}
						onRewind={onRewind}
					/>
				);
			})}
		</div>
	);
}

// ============================================================================
// AssistantToolGroup
// ============================================================================

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return n.toString();
}

function CacheStatsLine({
	msg,
	expectedCacheRead,
}: {
	msg: AssistantConversationMessageView;
	expectedCacheRead?: number;
}) {
	if (msg.promptTokens === undefined) return null;

	// promptTokens (= Anthropic input_tokens) is TOTAL input including cached/cache-write.
	// Uncached = total - cached - cache_write (the remainder billed at full price).
	const totalInput = msg.promptTokens ?? 0;
	const cached = msg.cachedTokens ?? 0;
	const cacheWrite = msg.cacheWriteTokens ?? 0;
	const uncached = totalInput - cached - cacheWrite;

	// Cache validation: compare actual cache read with expected (prev call total input)
	let cacheValidation: { ratio: number; ok: boolean } | undefined;
	if (expectedCacheRead !== undefined && expectedCacheRead > 0 && cached > 0) {
		const ratio = cached / expectedCacheRead;
		cacheValidation = { ratio, ok: ratio >= 0.9 };
	}

	return (
		<div className="flex items-center gap-1.5 text-[10px] tabular-nums flex-wrap">
			{uncached > 0 && (
				<span className="text-gray-400">{formatTokens(uncached)} in</span>
			)}
			{cached > 0 && (
				<span className="text-blue-500">
					{uncached > 0 ? "+ " : ""}
					{formatTokens(cached)} cached
				</span>
			)}
			{cacheWrite > 0 && (
				<span className="text-amber-500">
					+ {formatTokens(cacheWrite)} write
				</span>
			)}
			{cacheValidation && (
				<>
					<span className="text-gray-300">|</span>
					<span
						className={cacheValidation.ok ? "text-green-600" : "text-red-500"}
					>
						prev {formatTokens(expectedCacheRead!)} →{" "}
						{(cacheValidation.ratio * 100).toFixed(0)}% hit
					</span>
				</>
			)}
		</div>
	);
}

function AssistantToolGroup({
	group,
	expectedCacheRead,
	onRewind,
}: {
	group: {
		assistantMessage: AssistantConversationMessageView;
		toolInteractions: ToolInteraction[];
		messageIndex: number;
	};
	expectedCacheRead?: number;
	onRewind?: (messageIndex: number) => void;
}) {
	const { assistantMessage, toolInteractions } = group;
	const [textExpanded, setTextExpanded] = useState(false);
	const hasText = assistantMessage.content.trim().length > 0;
	const isTextTruncated =
		assistantMessage.content !== assistantMessage.fullContent;
	const displayText = textExpanded
		? assistantMessage.fullContent
		: assistantMessage.content;

	return (
		<div className="rounded-xl bg-white border border-gray-100 border-l-[3px] border-l-green-500 px-3.5 py-3">
			<div className="flex items-center gap-2 mb-1">
				<span className="text-[10px] font-bold uppercase tracking-wider text-green-700">
					assistant
				</span>
				{toolInteractions.length > 0 && (
					<span className="text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full font-medium">
						{toolInteractions.length} tool
						{toolInteractions.length !== 1 ? "s" : ""}
					</span>
				)}
				{assistantMessage.cost !== undefined && assistantMessage.cost > 0 && (
					<span className="text-[10px] text-emerald-600 font-medium tabular-nums">
						${assistantMessage.cost.toFixed(4)}
					</span>
				)}
				{assistantMessage.llmCallId && (
					<DebugLink
						to={`llm-calls/${assistantMessage.llmCallId}`}
						className="text-[10px] text-accent-peri hover:underline font-medium"
					>
						view llm call →
					</DebugLink>
				)}
				{onRewind && (
					<button
						type="button"
						onClick={() => onRewind(group.messageIndex)}
						className="text-[10px] text-orange-600 hover:underline font-medium cursor-pointer"
					>
						retry from here
					</button>
				)}
				<Timestamp value={assistantMessage.timestamp} />
			</div>

			<CacheStatsLine
				msg={assistantMessage}
				expectedCacheRead={expectedCacheRead}
			/>

			{hasText && (
				<div className="mt-1">
					<div className="whitespace-pre-wrap break-words text-gray-700 text-[12px] leading-relaxed">
						{displayText}
					</div>
					{isTextTruncated && (
						<button
							type="button"
							onClick={() => setTextExpanded(!textExpanded)}
							className="text-[11px] text-accent-peri hover:underline mt-1 font-medium cursor-pointer"
						>
							{textExpanded ? "Show less" : "Show more"}
						</button>
					)}
				</div>
			)}

			<div className={`space-y-1.5 ${hasText ? "mt-2" : ""}`}>
				{toolInteractions.map(({ call, response }) => (
					<ToolInteractionCard key={call.id} call={call} response={response} />
				))}
			</div>
		</div>
	);
}

// ============================================================================
// ToolInteractionCard
// ============================================================================

function oneLinePreview(value: unknown, maxLen = 80): string {
	const str = typeof value === "string" ? value : JSON.stringify(value);
	const line = str.replace(/\n/g, " ").trim();
	return line.length > maxLen ? line.slice(0, maxLen) + "…" : line;
}

function ToolInteractionCard({
	call,
	response,
}: {
	call: { id: string; name: string; input: unknown };
	response?: ToolConversationMessageView;
}) {
	const [expanded, setExpanded] = useState(false);
	const [resultExpanded, setResultExpanded] = useState(false);
	const status = response
		? response.isError
			? "failed"
			: "completed"
		: "pending";
	const isResultTruncated =
		response !== undefined && response.content !== response.fullContent;
	const displayResult = resultExpanded
		? response?.fullContent
		: response?.content;

	return (
		<div
			className={`rounded-lg border overflow-hidden ${
				response?.isError
					? "border-red-200 bg-red-50/50"
					: "border-gray-200 bg-gray-50/50"
			}`}
		>
			<button
				type="button"
				onClick={() => setExpanded(!expanded)}
				className="w-full flex items-start gap-2 px-2.5 py-2 text-left hover:bg-white/60 transition-colors cursor-pointer"
			>
				<ToolStatusDot status={status} />
				<div className="flex-1 min-w-0">
					<div className="flex items-center gap-1.5">
						<span className="font-mono font-medium text-[11px] text-gray-800">
							{call.name}
						</span>
						{response?.isError && (
							<span className="text-[9px] bg-red-100 text-red-700 px-1.5 py-0.5 rounded-full font-semibold">
								error
							</span>
						)}
						<Timestamp value={response?.timestamp} />
					</div>
					{!expanded && (
						<div className="mt-0.5 space-y-0">
							{call.input !== undefined && (
								<div className="text-[10px] text-gray-500 font-mono truncate">
									↑ {oneLinePreview(call.input)}
								</div>
							)}
							{response && (
								<div
									className={`text-[10px] font-mono truncate ${response.isError ? "text-red-600" : "text-gray-500"}`}
								>
									↓ {oneLinePreview(response.content)}
								</div>
							)}
						</div>
					)}
				</div>
				<svg
					className={`w-3 h-3 text-gray-400 transition-transform shrink-0 mt-0.5 ${expanded ? "rotate-90" : ""}`}
					fill="none"
					stroke="currentColor"
					viewBox="0 0 24 24"
				>
					<path
						strokeLinecap="round"
						strokeLinejoin="round"
						strokeWidth={2}
						d="M9 5l7 7-7 7"
					/>
				</svg>
			</button>

			{expanded && (
				<div className="px-2.5 pb-2.5 space-y-2 border-t border-gray-100">
					{call.input !== undefined && (
						<div className="mt-2">
							<div className="text-[9px] text-gray-500 uppercase tracking-wider font-medium mb-1">
								Input
							</div>
							<CodeBlock>{JSON.stringify(call.input, null, 2)}</CodeBlock>
						</div>
					)}

					{response && !response.isError && (
						<div>
							<div className="text-[9px] text-green-700 uppercase tracking-wider font-medium mb-1">
								Result
							</div>
							<CodeBlock variant="success">{displayResult ?? ""}</CodeBlock>
							{isResultTruncated && (
								<button
									type="button"
									onClick={(e) => {
										e.stopPropagation();
										setResultExpanded(!resultExpanded);
									}}
									className="text-[10px] text-accent-peri hover:underline mt-0.5 font-medium cursor-pointer"
								>
									{resultExpanded ? "Show less" : "Show more"}
								</button>
							)}
						</div>
					)}

					{response?.isError && (
						<div>
							<div className="text-[9px] text-red-700 uppercase tracking-wider font-medium mb-1">
								Error
							</div>
							<CodeBlock variant="error">{displayResult ?? ""}</CodeBlock>
							{isResultTruncated && (
								<button
									type="button"
									onClick={(e) => {
										e.stopPropagation();
										setResultExpanded(!resultExpanded);
									}}
									className="text-[10px] text-accent-peri hover:underline mt-0.5 font-medium cursor-pointer"
								>
									{resultExpanded ? "Show less" : "Show more"}
								</button>
							)}
						</div>
					)}
				</div>
			)}
		</div>
	);
}

// ============================================================================
// ConversationMessage (user, system, orphan tool)
// ============================================================================

const roleStyles: Record<
	string,
	{ bg: string; leftBorder: string; label: string }
> = {
	user: {
		bg: "bg-white",
		leftBorder: "border-l-blue-500",
		label: "text-blue-600",
	},
	assistant: {
		bg: "bg-white",
		leftBorder: "border-l-green-500",
		label: "text-green-700",
	},
	tool: {
		bg: "bg-white",
		leftBorder: "border-l-indigo-400",
		label: "text-indigo-600",
	},
	system: {
		bg: "bg-gray-50",
		leftBorder: "border-l-gray-300",
		label: "text-gray-500",
	},
};

function ConversationMessage({ msg }: { msg: ConversationMessageView }) {
	const [expanded, setExpanded] = useState(false);
	const style = roleStyles[msg.role] ?? roleStyles.system;
	const isTruncated = msg.content !== msg.fullContent;
	const displayContent = expanded ? msg.fullContent : msg.content;
	const isError = msg.role === "tool" && msg.isError;

	return (
		<div
			className={`rounded-xl border border-gray-100 border-l-[3px] px-3.5 py-3 ${
				isError
					? "bg-red-50 border-l-red-500"
					: `${style.bg} ${style.leftBorder}`
			}`}
		>
			<div className="flex items-center gap-2 mb-2">
				<span
					className={`text-[10px] font-bold uppercase tracking-wider ${isError ? "text-red-700" : style.label}`}
				>
					{msg.role}
				</span>
				{msg.role === "tool" && (
					<>
						<span className="text-[10px] text-gray-400 font-mono">
							{msg.toolCallId.slice(0, 12)}
						</span>
						{msg.isError && (
							<span className="text-[9px] bg-red-100 text-red-700 px-1.5 py-0.5 rounded-full font-semibold">
								error
							</span>
						)}
					</>
				)}
				{msg.role === "assistant" && msg.cost !== undefined && msg.cost > 0 && (
					<span className="text-[10px] text-emerald-600 font-medium tabular-nums">
						${msg.cost.toFixed(4)}
					</span>
				)}
				<Timestamp value={msg.timestamp} />
			</div>
			<div
				className={`whitespace-pre-wrap break-words text-[12px] leading-relaxed ${
					isError ? "text-red-800" : "text-gray-700"
				}`}
			>
				{displayContent}
			</div>
			{isTruncated && (
				<button
					type="button"
					onClick={() => setExpanded(!expanded)}
					className="text-[11px] text-accent-peri hover:underline mt-1.5 font-medium cursor-pointer"
				>
					{expanded ? "Show less" : "Show more"}
				</button>
			)}
		</div>
	);
}

// ============================================================================
// SendMessageForm
// ============================================================================

function SendMessageForm({
	sessionId,
	agentId,
}: {
	sessionId: string;
	agentId: string;
}) {
	const [content, setContent] = useState("");
	const [senderType, setSenderType] = useState<"user" | "debug" | "custom">(
		"user",
	);
	const [customSender, setCustomSender] = useState("");
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleSend = useCallback(async () => {
		if (!content.trim()) return;

		setSending(true);
		setError(null);

		try {
			if (senderType === "debug") {
				unwrap(
					await api.call("mailbox.send", {
						sessionId,
						toAgentId: AgentId(agentId),
						content: content.trim(),
						debug: true,
					}),
				);
			} else {
				unwrap(
					await api.call("user-chat.sendMessage", {
						sessionId,
						agentId: AgentId(agentId),
						content: content.trim(),
					}),
				);
			}
			setContent("");
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to send message");
		} finally {
			setSending(false);
		}
	}, [content, senderType, sessionId, agentId]);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				handleSend();
			}
		},
		[handleSend],
	);

	const handleSubmit = useCallback(
		(e: FormEvent) => {
			e.preventDefault();
			handleSend();
		},
		[handleSend],
	);

	return (
		<div className="bg-white rounded-2xl shadow-card p-4">
			<h3 className="text-sm font-semibold text-gray-900 mb-3">
				Send Debug Message
			</h3>
			<form onSubmit={handleSubmit} className="space-y-3">
				<div className="flex items-center gap-2">
					<label className="text-[11px] text-gray-400 font-medium">From:</label>
					<select
						value={senderType}
						onChange={(e) =>
							setSenderType(e.target.value as "user" | "debug" | "custom")
						}
						className="text-[11px] border border-gray-200 rounded-lg px-2 py-1 bg-gray-50"
					>
						<option value="user">user</option>
						<option value="debug">debug</option>
						<option value="custom">custom...</option>
					</select>
					{senderType === "custom" && (
						<input
							type="text"
							value={customSender}
							onChange={(e) => setCustomSender(e.target.value)}
							placeholder="agent ID or role"
							className="text-[11px] border border-gray-200 rounded-lg px-2 py-1 flex-1 bg-gray-50"
						/>
					)}
				</div>
				<textarea
					value={content}
					onChange={(e) => setContent(e.target.value)}
					onKeyDown={handleKeyDown}
					placeholder="Message content... (Enter to send, Shift+Enter for new line)"
					rows={3}
					className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm resize-y bg-gray-50"
				/>
				{error && <div className="text-[11px] text-red-600">{error}</div>}
				<button
					type="submit"
					disabled={sending || !content.trim()}
					className={`px-3 py-1.5 text-[11px] font-semibold rounded-lg transition-all ${
						content.trim()
							? "text-white bg-accent-peri hover:brightness-110 cursor-pointer shadow-sm"
							: "text-gray-400 bg-gray-100 cursor-not-allowed"
					} disabled:opacity-50 disabled:cursor-not-allowed`}
				>
					{sending ? "Sending..." : "Send Message"}
				</button>
			</form>
		</div>
	);
}

// ============================================================================
// ResumeAgentButton
// ============================================================================

function ResumeAgentButton({
	sessionId,
	agentId,
}: {
	sessionId: string;
	agentId: string;
}) {
	const [resuming, setResuming] = useState(false);

	const handleResume = useCallback(
		async (e: FormEvent) => {
			e.stopPropagation();
			setResuming(true);
			try {
				unwrap(
					await api.call("agents.resume", {
						sessionId,
						agentId: AgentId(agentId),
					}),
				);
			} catch {
				// Error is visible via state change (or lack thereof)
			} finally {
				setResuming(false);
			}
		},
		[sessionId, agentId],
	);

	return (
		<button
			type="button"
			onClick={handleResume}
			disabled={resuming}
			className="text-[11px] font-semibold text-white bg-red-600 hover:bg-red-700 px-2.5 py-1 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0 cursor-pointer"
		>
			{resuming ? "Resuming..." : "Resume"}
		</button>
	);
}

// ============================================================================
// Badges
// ============================================================================

function StatusBadge({ status }: { status: string }) {
	const styles: Record<string, string> = {
		idle: "bg-gray-100 text-gray-600",
		thinking: "bg-accent-lime/30 text-gray-700",
		responding: "bg-accent-peri/30 text-gray-700",
		waiting_for_user: "bg-purple-100 text-purple-700",
		error: "bg-red-100 text-red-700",
	};
	return (
		<span
			className={`text-[11px] px-2.5 py-1 rounded-full font-semibold ${styles[status] ?? "bg-gray-100 text-gray-600"}`}
		>
			{status}
		</span>
	);
}

function ToolStatusBadge({ status }: { status: string }) {
	const styles: Record<string, string> = {
		pending: "bg-gray-100 text-gray-600",
		executing: "bg-amber-100 text-amber-700",
		completed: "bg-green-100 text-green-700",
		failed: "bg-red-100 text-red-700",
	};
	return (
		<span
			className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${styles[status] ?? "bg-gray-100 text-gray-600"}`}
		>
			{status}
		</span>
	);
}

function ToolStatusDot({ status }: { status: string }) {
	const colors: Record<string, string> = {
		pending: "bg-gray-400",
		executing: "bg-amber-400 animate-pulse",
		completed: "bg-green-500",
		failed: "bg-red-500",
	};
	return (
		<div
			className={`w-2 h-2 rounded-full shrink-0 ${colors[status] ?? "bg-gray-400"}`}
		/>
	);
}
