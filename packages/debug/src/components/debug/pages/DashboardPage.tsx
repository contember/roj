import type { TimelineItem } from "@roj-ai/shared";
import { AgentId } from "@roj-ai/shared";
import { type FormEvent, useCallback, useMemo, useRef, useState } from "react";
import { api, unwrap } from "@roj-ai/client";
import {
	useEventStore,
	useMetrics,
	useSessionInfo,
	useTimeline,
} from "../../../stores/event-store";
import { formatDuration } from "../../../utils/format";
import { useDebugNavigate } from "../DebugNavigation";
import { TimelineDetailInspector } from "../TimelineDetailInspector";

export function DashboardPage() {
	const sessionInfo = useSessionInfo();
	const agentDetailProjection = useEventStore(
		(s) => s.agentDetailProjectionState,
	);
	const metrics = useMetrics();
	const timeline = useTimeline();
	const debugNavigate = useDebugNavigate();

	const failedLLMCalls = useMemo(
		() =>
			timeline.filter((item) => item.type === "llm" && item.status === "error"),
		[timeline],
	);

	const failedToolCalls = useMemo(
		() =>
			timeline.filter(
				(item) => item.type === "tool" && item.status === "error",
			),
		[timeline],
	);

	const agents = useMemo(
		() => Array.from(agentDetailProjection.agents.values()),
		[agentDetailProjection],
	);

	const agentNameById = useMemo(() => {
		const map = new Map<AgentId, string>();
		for (const agent of agents) map.set(agent.id, agent.definitionName);
		return map;
	}, [agents]);

	const pausedAgents = useMemo(
		() => agents.filter((a) => a.status === "paused"),
		[agents],
	);

	if (!sessionInfo.id) {
		return <div className="text-gray-400 text-sm">Loading session data...</div>;
	}

	return (
		<div className="space-y-4">
			{/* Paused agents banner */}
			{pausedAgents.length > 0 && (
				<div className="bg-red-50 border border-red-200 rounded-2xl p-4 space-y-2">
					{pausedAgents.map((agent) => (
						<div key={agent.id} className="flex items-center gap-3">
							<div className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" />
							<span className="text-sm font-semibold text-red-700 flex-1">
								{agent.definitionName}
								<span className="font-normal text-red-500 ml-1.5">
									paused
									{agent.pauseMessage
										? `: ${agent.pauseMessage}`
										: ` (${agent.pauseReason})`}
								</span>
							</span>
							<ResumeAgentButton
								sessionId={sessionInfo.id!}
								agentId={agent.id}
							/>
						</div>
					))}
				</div>
			)}

			{/* Top row: Session + Metrics */}
			<div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
				{/* Session Card */}
				<div className="lg:col-span-2 bg-white rounded-3xl shadow-soft p-5">
					<div className="flex items-center gap-3 mb-4">
						<div className="w-9 h-9 rounded-xl bg-accent-lime flex items-center justify-center shrink-0">
							<svg
								className="w-4 h-4 text-gray-900"
								fill="none"
								stroke="currentColor"
								viewBox="0 0 24 24"
							>
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={1.5}
									d="M13 10V3L4 14h7v7l9-11h-7z"
								/>
							</svg>
						</div>
						<div className="flex-1 min-w-0">
							<div className="font-bold text-gray-900">
								{sessionInfo.presetId}
							</div>
							<div className="text-[11px] text-gray-400 font-mono truncate">
								{sessionInfo.id}
							</div>
						</div>
						<StatusBadge status={sessionInfo.status} />
					</div>
					<div className="grid grid-cols-2 gap-x-5 gap-y-2.5">
						{sessionInfo.createdAt !== null && (
							<ConfigItem
								label="Started"
								value={new Date(sessionInfo.createdAt).toLocaleString()}
							/>
						)}
						{sessionInfo.closedAt ? (
							<ConfigItem
								label="Closed"
								value={new Date(sessionInfo.closedAt).toLocaleString()}
							/>
						) : (
							<div />
						)}
						<ConfigItem
							label="Duration"
							value={formatDuration(metrics.durationMs)}
						/>
						{sessionInfo.workspaceDir && (
							<ConfigItem
								label="Workspace"
								value={sessionInfo.workspaceDir}
								mono
							/>
						)}
					</div>
				</div>

				{/* Metrics Card */}
				<div className="lg:col-span-3 bg-white rounded-3xl shadow-soft p-5">
					<h3 className="text-sm font-semibold text-gray-900 mb-4">Overview</h3>
					<div className="grid grid-cols-3 gap-x-5 gap-y-4">
						<MetricItem
							label="Total Tokens"
							value={metrics.totalTokens.toLocaleString()}
							sub={`${metrics.promptTokens.toLocaleString()} / ${metrics.completionTokens.toLocaleString()}`}
						/>
						<MetricItem
							label="Cost"
							value={
								metrics.totalCost !== undefined && metrics.totalCost > 0
									? `$${metrics.totalCost.toFixed(4)}`
									: "$0.00"
							}
							accent
						/>
						<MetricItem
							label="LLM Calls"
							value={metrics.llmCalls.toString()}
							error={
								failedLLMCalls.length > 0
									? `${failedLLMCalls.length} failed`
									: undefined
							}
						/>
						<MetricItem
							label="Tool Calls"
							value={metrics.toolCalls.toString()}
							error={
								failedToolCalls.length > 0
									? `${failedToolCalls.length} failed`
									: undefined
							}
						/>
						<MetricItem label="Agents" value={metrics.agentCount.toString()} />
						<MetricItem
							label="Duration"
							value={formatDuration(metrics.durationMs)}
						/>
					</div>

					{/* Per-provider breakdown */}
					{Object.keys(metrics.byProvider).length > 0 && (
						<div className="mt-4 pt-3 border-t border-gray-100">
							<div className="text-[10px] font-medium uppercase tracking-wider text-gray-400 mb-2">
								By Provider
							</div>
							<div className="space-y-1.5">
								{Object.entries(metrics.byProvider).map(([name, p]) => (
									<div key={name} className="flex items-center gap-3 text-xs">
										<span className="font-medium text-gray-700 w-20">
											{name}
										</span>
										<span className="text-gray-500 tabular-nums">
											{p.llmCalls} calls
										</span>
										<span className="text-gray-500 tabular-nums">
											{p.totalTokens.toLocaleString()} tok
										</span>
										{p.totalCost > 0 && (
											<span className="text-green-600 tabular-nums">
												${p.totalCost.toFixed(4)}
											</span>
										)}
									</div>
								))}
							</div>
						</div>
					)}
				</div>
			</div>

			{/* Activity Timeline */}
			{timeline.length > 0 && <ActivityTimeline timeline={timeline} />}

			{/* LLM Cost & Cache by Agent */}
			<LLMCostByAgent agentNameById={agentNameById} />

			{/* Bottom: Agents + Status */}
			<div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
				{/* Spawned Agents */}
				<div className="bg-white rounded-3xl shadow-soft p-5">
					<div className="flex items-center justify-between mb-3">
						<div className="flex items-center gap-2.5">
							<svg
								className="w-4 h-4 text-gray-400"
								fill="none"
								stroke="currentColor"
								viewBox="0 0 24 24"
							>
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={1.5}
									d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
								/>
							</svg>
							<h3 className="text-sm font-semibold text-gray-900">
								Spawned Agents
							</h3>
						</div>
						<span className="text-[11px] bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full font-medium tabular-nums">
							{agents.length}
						</span>
					</div>
					{agents.length === 0 ? (
						<div className="text-gray-400 text-sm py-6 text-center">
							No agents spawned
						</div>
					) : (
						<div className="space-y-1.5">
							{agents.map((agent) => (
								<button
									key={agent.id}
									onClick={() => debugNavigate(`agents/${agent.id}`)}
									className="w-full bg-gray-50 rounded-xl px-3 py-2.5 flex items-center gap-2.5 hover:bg-gray-100 transition-colors text-left"
								>
									<div className="w-7 h-7 rounded-lg bg-white flex items-center justify-center shadow-card shrink-0">
										<svg
											className="w-3.5 h-3.5 text-gray-400"
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
										<div className="font-medium text-sm text-gray-900 leading-tight">
											{agent.definitionName}
										</div>
										<div className="text-[10px] text-gray-400 font-mono">
											{agent.id.slice(0, 12)}
										</div>
									</div>
									<AgentStatusBadge status={agent.status} />
									<svg
										className="w-3.5 h-3.5 text-gray-300 shrink-0"
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
							))}
						</div>
					)}
				</div>

				{/* Status / Failed Operations */}
				<div className="bg-white rounded-3xl shadow-soft p-5">
					<div className="flex items-center gap-2.5 mb-3">
						<svg
							className="w-4 h-4 text-gray-400"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
						>
							<path
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth={1.5}
								d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
							/>
						</svg>
						<h3 className="text-sm font-semibold text-gray-900">Status</h3>
					</div>

					{failedLLMCalls.length === 0 && failedToolCalls.length === 0 ? (
						<div className="bg-accent-lime/15 rounded-xl py-6 flex flex-col items-center gap-2">
							<div className="w-10 h-10 rounded-full bg-accent-lime flex items-center justify-center">
								<svg
									className="w-5 h-5 text-gray-900"
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
							</div>
							<div className="text-sm font-semibold text-gray-900">
								All operations healthy
							</div>
							<div className="text-[11px] text-gray-500">
								No failures detected
							</div>
						</div>
					) : (
						<div className="space-y-3">
							{failedLLMCalls.length > 0 && (
								<div>
									<div className="flex items-center gap-1.5 mb-1.5">
										<div className="w-1.5 h-1.5 rounded-full bg-red-500" />
										<span className="text-[11px] font-semibold text-gray-600">
											Failed LLM Calls ({failedLLMCalls.length})
										</span>
									</div>
									<div className="space-y-1">
										{failedLLMCalls.map((call) => (
											<button
												key={call.id}
												onClick={() =>
													debugNavigate(
														`llm-calls/${call.llmCallId ?? call.id}`,
													)
												}
												className="w-full text-left bg-red-50 rounded-lg px-3 py-2 hover:bg-red-100 transition-colors"
											>
												<div className="flex items-center gap-2 text-[11px]">
													<span className="text-gray-400">
														{new Date(call.startedAt).toLocaleTimeString()}
													</span>
													<span className="font-mono font-medium text-gray-700">
														{call.agentName}
													</span>
													{call.model && (
														<span className="text-gray-400">{call.model}</span>
													)}
												</div>
												{call.error && (
													<div className="text-[11px] text-red-600 mt-0.5 truncate">
														{call.error}
													</div>
												)}
											</button>
										))}
									</div>
								</div>
							)}

							{failedToolCalls.length > 0 && (
								<div>
									<div className="flex items-center gap-1.5 mb-1.5">
										<div className="w-1.5 h-1.5 rounded-full bg-red-500" />
										<span className="text-[11px] font-semibold text-gray-600">
											Failed Tool Calls ({failedToolCalls.length})
										</span>
									</div>
									<div className="space-y-1">
										{failedToolCalls.map((call) => (
											<div
												key={call.id}
												className="bg-red-50 rounded-lg px-3 py-2"
											>
												<div className="flex items-center gap-2 text-[11px]">
													<span className="text-gray-400">
														{new Date(call.startedAt).toLocaleTimeString()}
													</span>
													<span className="font-mono font-medium text-gray-700">
														{call.agentName}
													</span>
													<span className="font-medium text-gray-600">
														{call.toolName}
													</span>
												</div>
												{call.error && (
													<div className="text-[11px] text-red-600 mt-0.5 truncate">
														{call.error}
													</div>
												)}
											</div>
										))}
									</div>
								</div>
							)}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

function ConfigItem({
	label,
	value,
	mono,
}: {
	label: string;
	value: string;
	mono?: boolean;
}) {
	return (
		<div>
			<div className="text-[10px] text-gray-400 uppercase tracking-wider font-medium">
				{label}
			</div>
			<div
				className={`text-gray-700 truncate ${mono ? "font-mono text-[11px]" : "text-sm"}`}
				title={value}
			>
				{value}
			</div>
		</div>
	);
}

function MetricItem({
	label,
	value,
	sub,
	error,
	accent,
}: {
	label: string;
	value: string;
	sub?: string;
	error?: string;
	accent?: boolean;
}) {
	return (
		<div>
			<div className="text-[10px] font-medium uppercase tracking-wider text-gray-400 mb-0.5">
				{label}
			</div>
			<div
				className={`text-xl font-bold tabular-nums tracking-tight ${accent ? "text-green-600" : "text-gray-900"}`}
			>
				{value}
			</div>
			{sub && (
				<div className="text-[10px] text-gray-400 tabular-nums mt-0.5">
					{sub}
				</div>
			)}
			{error && (
				<div className="text-[10px] text-red-500 font-medium mt-0.5">
					{error}
				</div>
			)}
		</div>
	);
}

function StatusBadge({ status }: { status: "active" | "closed" }) {
	return status === "active" ? (
		<div className="flex items-center gap-1.5 bg-accent-lime/30 px-2.5 py-1 rounded-full">
			<div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
			<span className="text-[11px] font-semibold text-gray-700">Active</span>
		</div>
	) : (
		<div className="flex items-center gap-1.5 bg-gray-100 px-2.5 py-1 rounded-full">
			<div className="w-1.5 h-1.5 rounded-full bg-gray-400" />
			<span className="text-[11px] font-semibold text-gray-500">Closed</span>
		</div>
	);
}

function AgentStatusBadge({ status }: { status: string }) {
	const styles: Record<string, string> = {
		pending: "bg-gray-100 text-gray-600",
		inferring: "bg-accent-lime/30 text-gray-700",
		tool_exec: "bg-accent-peri/30 text-gray-700",
		errored: "bg-red-100 text-red-700",
		done: "bg-green-100 text-green-700",
	};
	return (
		<span
			className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${styles[status] ?? "bg-gray-100 text-gray-600"}`}
		>
			{status}
		</span>
	);
}

// ============================================================================
// LLM Cost & Cache by Agent
// ============================================================================

interface AgentCostRow {
	agentId: AgentId;
	agentName: string;
	calls: number;
	errors: number;
	cost: number;
	uncachedPromptTokens: number;
	cachedTokens: number;
	cacheWriteTokens: number;
	completionTokens: number;
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return n.toString();
}

function ratioColor(ratio: number): string {
	if (ratio >= 0.7) return "text-green-600";
	if (ratio >= 0.4) return "text-amber-600";
	return "text-red-600";
}

function LLMCostByAgent({
	agentNameById,
}: {
	agentNameById: Map<AgentId, string>;
}) {
	const debugNavigate = useDebugNavigate();
	const timeline = useTimeline();

	const { rows, totals } = useMemo(() => {
		const llmItems = timeline.filter((it) => it.type === "llm");
		const byAgent = new Map<AgentId, AgentCostRow>();
		let totalCost = 0;
		let totalUncachedPrompt = 0;
		let totalCached = 0;
		let totalCacheWrite = 0;
		let totalCompletion = 0;
		let totalCalls = 0;
		let totalErrors = 0;

		for (const item of llmItems) {
			const isError = item.status === "error";
			let row = byAgent.get(item.agentId);
			if (!row) {
				row = {
					agentId: item.agentId,
					agentName: agentNameById.get(item.agentId) ?? item.agentId,
					calls: 0,
					errors: 0,
					cost: 0,
					uncachedPromptTokens: 0,
					cachedTokens: 0,
					cacheWriteTokens: 0,
					completionTokens: 0,
				};
				byAgent.set(item.agentId, row);
			}
			row.calls += 1;
			totalCalls += 1;
			if (isError) {
				row.errors += 1;
				totalErrors += 1;
			}
			// promptTokens (= Anthropic input_tokens) is TOTAL input including cached/cache-write.
			// Uncached = total - cached - cache_write.
			const totalInput = item.promptTokens ?? 0;
			const cached = item.cachedTokens ?? 0;
			const cacheWrite = item.cacheWriteTokens ?? 0;
			const uncached = totalInput - cached - cacheWrite;

			row.cost += item.cost ?? 0;
			row.uncachedPromptTokens += uncached;
			row.cachedTokens += cached;
			row.cacheWriteTokens += cacheWrite;
			row.completionTokens += item.completionTokens ?? 0;
			totalCost += item.cost ?? 0;
			totalUncachedPrompt += uncached;
			totalCached += cached;
			totalCacheWrite += cacheWrite;
			totalCompletion += item.completionTokens ?? 0;
		}

		const sorted = Array.from(byAgent.values()).sort((a, b) => b.cost - a.cost);
		// Cache ratio: cached / total input (= uncached + cached + cacheWrite)
		const totalInputAll = totalUncachedPrompt + totalCached + totalCacheWrite;
		const cacheRatio = totalInputAll > 0 ? totalCached / totalInputAll : 0;

		return {
			rows: sorted,
			totals: {
				calls: totalCalls,
				errors: totalErrors,
				cost: totalCost,
				uncachedPromptTokens: totalUncachedPrompt,
				cachedTokens: totalCached,
				cacheWriteTokens: totalCacheWrite,
				completionTokens: totalCompletion,
				cacheRatio,
			},
		};
	}, [timeline, agentNameById]);

	if (rows.length === 0) {
		return null;
	}

	const maxCost = Math.max(...rows.map((r) => r.cost), 0.0001);

	return (
		<div className="bg-white rounded-3xl shadow-soft p-5">
			<div className="flex items-center justify-between mb-4">
				<div>
					<h3 className="text-sm font-semibold text-gray-900">
						LLM Cost & Cache by Agent
					</h3>
					<div className="text-[10px] text-gray-400 mt-0.5">
						Cache ratio = cached / (cached + uncached input). Low ratio means
						the prompt cache isn't being reused effectively.
					</div>
				</div>
				<div className="flex items-center gap-5">
					<SummaryStat
						label="Total Cost"
						value={`$${totals.cost.toFixed(4)}`}
						accent
					/>
					<SummaryStat
						label="Cache Hit Ratio"
						value={`${(totals.cacheRatio * 100).toFixed(1)}%`}
						valueClass={ratioColor(totals.cacheRatio)}
					/>
					<SummaryStat
						label="Uncached Input"
						value={formatTokens(totals.uncachedPromptTokens)}
					/>
					<SummaryStat
						label="Cached Read"
						value={formatTokens(totals.cachedTokens)}
					/>
					<SummaryStat
						label="Cache Write"
						value={formatTokens(totals.cacheWriteTokens)}
					/>
					<SummaryStat
						label="Completion"
						value={formatTokens(totals.completionTokens)}
					/>
				</div>
			</div>

			<div className="overflow-x-auto">
				<table className="w-full text-xs">
					<thead>
						<tr className="text-[10px] font-medium uppercase tracking-wider text-gray-400 border-b border-gray-100">
							<th className="text-left py-2 pl-1 font-medium">Agent</th>
							<th className="text-right py-2 font-medium">Calls</th>
							<th className="text-right py-2 font-medium">Cost</th>
							<th
								className="py-2 pl-4 pr-2 font-medium"
								style={{ width: "34%" }}
							>
								Cost share
							</th>
							<th className="text-right py-2 font-medium">Uncached In</th>
							<th className="text-right py-2 font-medium">Cached</th>
							<th className="text-right py-2 font-medium">Cache Write</th>
							<th className="text-right py-2 font-medium">Out</th>
							<th className="text-right py-2 pr-1 font-medium">Cache %</th>
						</tr>
					</thead>
					<tbody>
						{rows.map((r) => {
							const inputTotal =
								r.uncachedPromptTokens + r.cachedTokens + r.cacheWriteTokens;
							const cacheRatio =
								inputTotal > 0 ? r.cachedTokens / inputTotal : 0;
							const costPct = (r.cost / maxCost) * 100;
							return (
								<tr
									key={r.agentId}
									className="border-b border-gray-50 hover:bg-gray-50 cursor-pointer"
									onClick={() => debugNavigate(`agents/${r.agentId}`)}
								>
									<td className="py-2 pl-1">
										<div className="font-medium text-gray-900">
											{r.agentName}
										</div>
										<div className="text-[10px] text-gray-400 font-mono">
											{r.agentId.slice(0, 12)}
										</div>
									</td>
									<td className="text-right py-2 tabular-nums text-gray-700">
										{r.calls}
										{r.errors > 0 && (
											<span className="text-red-500 ml-1">({r.errors}!)</span>
										)}
									</td>
									<td className="text-right py-2 tabular-nums font-semibold text-green-700">
										${r.cost.toFixed(4)}
									</td>
									<td className="py-2 pl-4 pr-2">
										<div className="h-2 bg-gray-100 rounded-full overflow-hidden">
											<div
												className="h-full bg-green-500 rounded-full"
												style={{ width: `${costPct}%` }}
											/>
										</div>
									</td>
									<td className="text-right py-2 tabular-nums text-gray-700">
										{formatTokens(r.uncachedPromptTokens)}
									</td>
									<td className="text-right py-2 tabular-nums text-gray-500">
										{formatTokens(r.cachedTokens)}
									</td>
									<td className="text-right py-2 tabular-nums text-gray-500">
										{formatTokens(r.cacheWriteTokens)}
									</td>
									<td className="text-right py-2 tabular-nums text-gray-500">
										{formatTokens(r.completionTokens)}
									</td>
									<td
										className={`text-right py-2 pr-1 tabular-nums font-semibold ${ratioColor(cacheRatio)}`}
									>
										{(cacheRatio * 100).toFixed(0)}%
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
		</div>
	);
}

function SummaryStat({
	label,
	value,
	accent,
	valueClass,
}: {
	label: string;
	value: string;
	accent?: boolean;
	valueClass?: string;
}) {
	return (
		<div className="text-right">
			<div className="text-[9px] font-medium uppercase tracking-wider text-gray-400">
				{label}
			</div>
			<div
				className={`text-sm font-bold tabular-nums ${
					valueClass ?? (accent ? "text-green-600" : "text-gray-900")
				}`}
			>
				{value}
			</div>
		</div>
	);
}

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

function formatChartTime(ts: number, rangeMs: number): string {
	const d = new Date(ts);
	const hh = d.getHours().toString().padStart(2, "0");
	const mm = d.getMinutes().toString().padStart(2, "0");
	const ss = d.getSeconds().toString().padStart(2, "0");
	if (rangeMs < 120_000) return `${mm}:${ss}`;
	return `${hh}:${mm}:${ss}`;
}

const MAX_LANES = 8;

type NarrowItem = {
	x: number;
	type: "llm" | "tool";
	isError: boolean;
	source: TimelineItem;
};
type NarrowCluster = { centerX: number; items: NarrowItem[] };

/** Group nearby narrow items into clusters for fan-marker rendering */
function groupNarrowItems(
	narrowItems: NarrowItem[],
	minDist = 10,
): NarrowCluster[] {
	const clusters: Array<NarrowCluster & { sumX: number }> = [];
	for (const item of narrowItems) {
		const existing = clusters.find(
			(c) => Math.abs(c.centerX - item.x) < minDist,
		);
		if (existing) {
			existing.sumX += item.x;
			existing.items.push(item);
			existing.centerX = existing.sumX / existing.items.length;
		} else {
			clusters.push({ centerX: item.x, items: [item], sumX: item.x });
		}
	}
	return clusters;
}

function dotColor(item: NarrowItem): string {
	if (item.isError) return "#EF4444";
	return item.type === "llm" ? "#7CA3F0" : "#84CC16";
}

function ActivityTimeline({ timeline }: { timeline: TimelineItem[] }) {
	const sessionId = useEventStore((s) => s.sessionInfoState.id ?? "");
	const items = timeline.filter((it) => it.type !== "compaction");
	const hasItems = items.length > 0;

	// Time range
	const allTimes = items.flatMap((it) => [
		it.startedAt,
		...(it.completedAt ? [it.completedAt] : []),
	]);
	const minTime = Math.min(...allTimes);
	const maxTime = Math.max(...allTimes);
	const timeRange = Math.max(maxTime - minTime, 1000);

	// Group by agent, sorted by first appearance
	const agentMap = new Map<string, TimelineItem[]>();
	for (const item of items) {
		const list = agentMap.get(item.agentName) ?? [];
		list.push(item);
		agentMap.set(item.agentName, list);
	}
	const allAgents = [...agentMap.entries()].sort(
		(a, b) =>
			Math.min(...a[1].map((i) => i.startedAt)) -
			Math.min(...b[1].map((i) => i.startedAt)),
	);
	const displayAgents = allAgents.slice(0, MAX_LANES);
	const hiddenCount = allAgents.length - displayAgents.length;

	// Layout constants
	const leftMargin = 64;
	const rightMargin = 6;
	const laneHeight = 12;
	const chartWidth = 900;
	const bottomMargin = 10;
	const contentWidth = chartWidth - leftMargin - rightMargin;
	const minBarWidth = 5;

	const timeToX = (t: number) =>
		leftMargin + ((t - minTime) / timeRange) * contentWidth;

	// Pre-compute which items are narrow (too small to see as bars) per lane
	const laneNarrowItems = displayAgents.map(([, agentItems]) => {
		const narrow: NarrowItem[] = [];
		for (const item of agentItems) {
			const x1 = timeToX(item.startedAt);
			const x2 = timeToX(item.completedAt ?? maxTime);
			const w = x2 - x1;
			if (w < minBarWidth) {
				narrow.push({
					x: x1,
					type: item.type as "llm" | "tool",
					isError: item.status === "error",
					source: item,
				});
			}
		}
		return narrow;
	});
	const hasNarrowItems = laneNarrowItems.some((n) => n.length > 0);

	const laneGap = hasNarrowItems ? 8 : 2;
	const topMargin = hasNarrowItems ? 8 : 0;
	const lanesHeight =
		topMargin +
		displayAgents.length * laneHeight +
		Math.max(0, displayAgents.length - 1) * laneGap;
	const totalHeight = lanesHeight + bottomMargin;

	const getLaneY = (index: number) =>
		topMargin + index * (laneHeight + laneGap);

	// Time labels (~5)
	const labelCount = 5;
	const timeLabels = Array.from({ length: labelCount }, (_, i) => {
		const t = minTime + (i / (labelCount - 1)) * timeRange;
		return { x: timeToX(t), label: formatChartTime(t, timeRange) };
	});

	// Fan marker geometry
	const stemHeight = 5;
	const dotRadius = 1.5;
	const dotSpacing = 4;
	const minDotGap = dotRadius * 2 + 1;

	// Stats
	const llmItems = items.filter(
		(it) => it.type === "llm" && it.durationMs !== undefined,
	);
	const toolItems = items.filter(
		(it) => it.type === "tool" && it.durationMs !== undefined,
	);
	const avgLlmMs =
		llmItems.length > 0
			? llmItems.reduce((s, it) => s + (it.durationMs ?? 0), 0) /
				llmItems.length
			: 0;
	const totalLlmMs = llmItems.reduce((s, it) => s + (it.durationMs ?? 0), 0);
	const totalToolMs = toolItems.reduce((s, it) => s + (it.durationMs ?? 0), 0);
	const totalMs = totalLlmMs + totalToolMs;
	const llmPercent = totalMs > 0 ? Math.round((totalLlmMs / totalMs) * 100) : 0;

	const completedItems = items.filter((it) => it.durationMs !== undefined);
	const longest =
		completedItems.length > 0
			? completedItems.reduce((max, it) =>
					(it.durationMs ?? 0) > (max.durationMs ?? 0) ? it : max,
				)
			: null;

	// Hover popover state
	const containerRef = useRef<HTMLDivElement>(null);
	const debugNavigate = useDebugNavigate();
	const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [tooltip, setTooltip] = useState<{
		item: TimelineItem;
		x: number;
		y: number;
	} | null>(null);
	const [modalItem, setModalItem] = useState<TimelineItem | null>(null);

	const showTooltip = useCallback((item: TimelineItem, e: React.MouseEvent) => {
		if (hideTimer.current) clearTimeout(hideTimer.current);
		const rect = containerRef.current?.getBoundingClientRect();
		if (!rect) return;
		setTooltip({ item, x: e.clientX - rect.left, y: e.clientY - rect.top });
	}, []);

	const scheduleHide = useCallback(() => {
		hideTimer.current = setTimeout(() => setTooltip(null), 150);
	}, []);

	const cancelHide = useCallback(() => {
		if (hideTimer.current) clearTimeout(hideTimer.current);
	}, []);

	if (!hasItems) return null;

	return (
		<div className="bg-white rounded-3xl shadow-soft p-5">
			<h3 className="text-sm font-semibold text-gray-900 mb-2">
				Activity Timeline
			</h3>

			{/* Chart + popover container */}
			<div ref={containerRef} className="relative">
				<svg
					viewBox={`0 0 ${chartWidth} ${totalHeight}`}
					className="w-full"
					preserveAspectRatio="xMidYMid meet"
				>
					{/* Vertical grid lines */}
					{timeLabels.map(({ x }, i) => (
						<line
							key={`grid-${i}`}
							x1={x}
							y1={topMargin}
							x2={x}
							y2={lanesHeight}
							stroke="#F3F4F6"
							strokeWidth={0.5}
						/>
					))}

					{/* Agent lanes */}
					{displayAgents.map(([agentName, agentItems], laneIndex) => {
						const y = getLaneY(laneIndex);
						const narrowItems = laneNarrowItems[laneIndex];
						const clusters = groupNarrowItems(narrowItems);

						// Wide items render as bars, narrow items render as fan markers
						const wideItems = agentItems.filter((item) => {
							const x1 = timeToX(item.startedAt);
							const x2 = timeToX(item.completedAt ?? maxTime);
							return x2 - x1 >= minBarWidth;
						});

						return (
							<g key={agentName}>
								{/* Agent name */}
								<text
									x={leftMargin - 4}
									y={y + laneHeight / 2 + 2}
									textAnchor="end"
									fill="#6B7280"
									fontSize={5}
									fontFamily="ui-monospace, monospace"
								>
									{agentName.length > 12
										? agentName.slice(0, 12) + "\u2026"
										: agentName}
								</text>

								{/* Lane background */}
								<rect
									x={leftMargin}
									y={y}
									width={contentWidth}
									height={laneHeight}
									fill="#F4F5F7"
									rx={1}
								/>

								{/* Wide operation bars */}
								{wideItems.map((item) => {
									const x1 = timeToX(item.startedAt);
									const x2 = timeToX(item.completedAt ?? maxTime);
									const w = x2 - x1;
									const isRunning = item.status === "running";
									const isError = item.status === "error";

									return (
										<rect
											key={item.id}
											x={x1}
											y={y + 2}
											width={w}
											height={laneHeight - 4}
											fill={
												isError
													? "#EF4444"
													: item.type === "llm"
														? "#7CA3F0"
														: "#84CC16"
											}
											rx={1}
											opacity={isRunning ? 0.4 : 1}
											strokeDasharray={isRunning ? "3 2" : undefined}
											stroke={isRunning ? "#6B7280" : "none"}
											strokeWidth={isRunning ? 0.5 : 0}
											style={{ cursor: "pointer" }}
											onMouseEnter={(e) => showTooltip(item, e)}
											onMouseLeave={scheduleHide}
											onClick={() => setModalItem(item)}
										/>
									);
								})}

								{/* Fan markers for narrow/clustered items — globally resolved per lane */}
								{(() => {
									if (clusters.length === 0) return null;

									// Collect all dots across all clusters
									const allDots: Array<{
										x: number;
										color: string;
										clusterX: number;
										stemColor: string;
										source: TimelineItem;
									}> = [];
									const ticks: Array<{ x: number; hasError: boolean }> = [];

									for (const cluster of clusters) {
										const bx = cluster.centerX;
										const hasErr = cluster.items.some((it) => it.isError);
										ticks.push({ x: bx, hasError: hasErr });
										const fw =
											Math.max(0, cluster.items.length - 1) * dotSpacing;
										const sc = hasErr ? "#EF4444" : "#9CA3AF";
										for (let i = 0; i < cluster.items.length; i++) {
											allDots.push({
												x: bx - fw / 2 + i * dotSpacing,
												color: dotColor(cluster.items[i]),
												clusterX: bx,
												stemColor: sc,
												source: cluster.items[i].source,
											});
										}
									}

									// Sort by x, resolve overlaps, then clamp with backward pass
									allDots.sort((a, b) => a.x - b.x);
									const xMin = leftMargin + dotRadius;
									const xMax = leftMargin + contentWidth - dotRadius;

									// Forward pass: push right to resolve overlaps
									for (let i = 1; i < allDots.length; i++) {
										if (allDots[i].x - allDots[i - 1].x < minDotGap) {
											allDots[i] = {
												...allDots[i],
												x: allDots[i - 1].x + minDotGap,
											};
										}
									}

									// Clamp rightmost, then backward pass to spread left
									if (
										allDots.length > 0 &&
										allDots[allDots.length - 1].x > xMax
									) {
										allDots[allDots.length - 1] = {
											...allDots[allDots.length - 1],
											x: xMax,
										};
									}
									for (let i = allDots.length - 2; i >= 0; i--) {
										if (allDots[i + 1].x - allDots[i].x < minDotGap) {
											allDots[i] = {
												...allDots[i],
												x: allDots[i + 1].x - minDotGap,
											};
										}
									}

									// Clamp leftmost
									if (allDots.length > 0 && allDots[0].x < xMin) {
										allDots[0] = { ...allDots[0], x: xMin };
									}

									const dotY = y - stemHeight;

									return (
										<>
											{ticks.map((tick, ti) => (
												<line
													key={`t-${ti}`}
													x1={tick.x}
													y1={y}
													x2={tick.x}
													y2={y + laneHeight}
													stroke={tick.hasError ? "#EF4444" : "#9CA3AF"}
													strokeWidth={tick.hasError ? 1.5 : 1}
												/>
											))}
											{allDots.map((dot, di) => (
												<g
													key={`fd-${di}`}
													style={{ cursor: "pointer" }}
													onMouseEnter={(e) => showTooltip(dot.source, e)}
													onMouseLeave={scheduleHide}
													onClick={() => setModalItem(dot.source)}
												>
													<path
														d={`M ${dot.clusterX} ${y - 0.5} Q ${dot.clusterX} ${y - stemHeight * 0.4}, ${dot.x} ${dotY}`}
														fill="none"
														stroke={dot.stemColor}
														strokeWidth={0.5}
														opacity={0.3}
													/>
													{/* Invisible hit area for small dots */}
													<circle
														cx={dot.x}
														cy={dotY}
														r={dotRadius + 3}
														fill="transparent"
													/>
													<circle
														cx={dot.x}
														cy={dotY}
														r={dotRadius}
														fill={dot.color}
													/>
												</g>
											))}
										</>
									);
								})()}
							</g>
						);
					})}

					{/* Time axis labels */}
					{timeLabels.map(({ x, label }, i) => (
						<text
							key={`time-${i}`}
							x={x}
							y={totalHeight - 1}
							textAnchor="middle"
							fill="#9CA3AF"
							fontSize={5}
						>
							{label}
						</text>
					))}
				</svg>

				{/* Hover tooltip */}
				{tooltip && (
					<div
						className="absolute z-50 bg-white rounded-xl shadow-lg border border-gray-100 py-2 px-2.5 text-[11px] pointer-events-auto"
						style={{
							left: tooltip.x,
							top: tooltip.y - 8,
							transform: "translate(-50%, -100%)",
						}}
						onMouseEnter={cancelHide}
						onMouseLeave={scheduleHide}
					>
						<HoverTooltipContent
							item={tooltip.item}
							onViewDetail={() => {
								setModalItem(tooltip.item);
								setTooltip(null);
							}}
						/>
					</div>
				)}
			</div>

			{hiddenCount > 0 && (
				<div className="text-[10px] text-gray-400 mt-0.5 text-right">
					+{hiddenCount} more agents
				</div>
			)}

			{/* Footer: legend + stats */}
			<div className="flex items-center gap-4 mt-3 pt-2.5 border-t border-gray-100 text-[11px] text-gray-500">
				<div className="flex items-center gap-1.5">
					<div
						className="w-2 h-2 rounded-sm"
						style={{ backgroundColor: "#7CA3F0" }}
					/>
					<span>LLM</span>
				</div>
				<div className="flex items-center gap-1.5">
					<div
						className="w-2 h-2 rounded-sm"
						style={{ backgroundColor: "#84CC16" }}
					/>
					<span>Tool</span>
				</div>
				<div className="flex items-center gap-1.5">
					<div
						className="w-2 h-2 rounded-full"
						style={{ backgroundColor: "#EF4444" }}
					/>
					<span>Error</span>
				</div>
				{hasNarrowItems && (
					<div className="flex items-center gap-1.5">
						<svg width="8" height="8" viewBox="0 0 8 8">
							<circle cx="2" cy="2" r="1.5" fill="#9CA3AF" />
							<circle cx="6" cy="2" r="1.5" fill="#9CA3AF" />
							<line
								x1="4"
								y1="7"
								x2="2"
								y2="3"
								stroke="#9CA3AF"
								strokeWidth="0.5"
							/>
							<line
								x1="4"
								y1="7"
								x2="6"
								y2="3"
								stroke="#9CA3AF"
								strokeWidth="0.5"
							/>
						</svg>
						<span>Clustered</span>
					</div>
				)}

				{completedItems.length > 0 && (
					<>
						<div className="w-px h-3 bg-gray-200 ml-1" />
						{llmItems.length > 0 && (
							<div>
								<span className="text-gray-400">Avg LLM </span>
								<span className="font-semibold text-gray-700 tabular-nums">
									{formatDuration(avgLlmMs)}
								</span>
							</div>
						)}
						{longest && (
							<div>
								<span className="text-gray-400">Longest </span>
								<span className="font-semibold text-gray-700 tabular-nums">
									{formatDuration(longest.durationMs ?? 0)}
								</span>
								<span className="text-gray-400 ml-1">
									{longest.toolName ?? longest.model ?? ""}
								</span>
							</div>
						)}
						{totalMs > 0 && (
							<div className="flex items-center gap-1.5 ml-auto">
								<div className="w-16 h-1.5 rounded-full bg-gray-200 overflow-hidden flex">
									<div
										className="h-full"
										style={{
											width: `${llmPercent}%`,
											backgroundColor: "#7CA3F0",
										}}
									/>
									<div
										className="h-full"
										style={{
											width: `${100 - llmPercent}%`,
											backgroundColor: "#84CC16",
										}}
									/>
								</div>
								<span className="text-gray-400 tabular-nums">
									{llmPercent}%
								</span>
							</div>
						)}
					</>
				)}
			</div>

			{/* Detail Modal */}
			{modalItem && (
				<div
					className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
					onClick={() => setModalItem(null)}
				>
					<div
						className="bg-white rounded-2xl shadow-lg w-full max-w-2xl max-h-[80vh] flex flex-col mx-4"
						onClick={(e) => e.stopPropagation()}
					>
						<div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 shrink-0">
							<h3 className="text-sm font-semibold text-gray-900">
								Detail Inspector
							</h3>
							<button
								type="button"
								onClick={() => setModalItem(null)}
								className="text-gray-400 hover:text-gray-600 cursor-pointer"
							>
								<svg
									className="w-4 h-4"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M6 18L18 6M6 6l12 12"
									/>
								</svg>
							</button>
						</div>
						<div className="flex-1 overflow-auto p-5">
							<TimelineDetailInspector
								sessionId={sessionId}
								item={modalItem}
								onNavigate={(path) => {
									debugNavigate(path);
									setModalItem(null);
								}}
							/>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

function HoverTooltipContent({
	item,
	onViewDetail,
}: {
	item: TimelineItem;
	onViewDetail: () => void;
}) {
	const isLLM = item.type === "llm";
	const statusColor =
		item.status === "error"
			? "text-red-600"
			: item.status === "running"
				? "text-amber-500"
				: "text-green-600";

	return (
		<div className="min-w-36">
			<div className="flex items-center gap-1.5 mb-1">
				<div
					className="w-1.5 h-1.5 rounded-full"
					style={{
						backgroundColor:
							item.status === "error"
								? "#EF4444"
								: isLLM
									? "#7CA3F0"
									: "#84CC16",
					}}
				/>
				<span className="font-semibold text-gray-900">
					{isLLM
						? (item.model?.split("/").pop() ?? "LLM")
						: (item.toolName ?? "Tool")}
				</span>
				<span className={`ml-auto text-[10px] ${statusColor}`}>
					{item.status}
				</span>
			</div>
			<div className="text-gray-400 space-y-0.5">
				<div>
					<span className="text-gray-700 font-mono">{item.agentName}</span>
				</div>
				{item.durationMs !== undefined && (
					<div>
						<span className="text-gray-700 font-semibold tabular-nums">
							{formatDuration(item.durationMs)}
						</span>
						{isLLM && item.cost !== undefined && item.cost > 0 && (
							<span className="text-green-600 ml-2">
								${item.cost.toFixed(4)}
							</span>
						)}
					</div>
				)}
				{item.error && (
					<div className="text-red-500 truncate max-w-48" title={item.error}>
						{item.error}
					</div>
				)}
			</div>
			<button
				type="button"
				onClick={onViewDetail}
				className="mt-1.5 pt-1.5 border-t border-gray-100 w-full text-left text-accent-peri hover:underline font-medium cursor-pointer"
			>
				View details &rarr;
			</button>
		</div>
	);
}
