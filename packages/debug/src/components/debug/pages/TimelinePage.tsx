import type { TimelineItem } from '@roj-ai/shared'
import { useState } from 'react'
import { DebugLink, useDebugSessionId } from '../DebugNavigation'
import { useEventStore, useTimeline } from '../../../stores/event-store'
import { LLMCallDetail } from '../LLMCallDetail'

export function TimelinePage() {
	const sessionId = useDebugSessionId()

	// Get timeline from event store (already loaded by DebugLayout)
	const items = useTimeline()
	const isLoading = useEventStore((s) => s.isLoading)
	const error = useEventStore((s) => s.error)

	const [selectedId, setSelectedId] = useState<string | null>(null)

	const selectedItem = selectedId ? items.find((i) => i.id === selectedId) : null
	const total = items.length

	// Calculate stats
	const llmCount = items.filter((i) => i.type === 'llm').length
	const toolCount = items.filter((i) => i.type === 'tool').length
	const compactionCount = items.filter((i) => i.type === 'compaction').length
	const totalCost = items.reduce((sum, i) => sum + (i.cost ?? 0), 0)
	const totalTokens = items.reduce(
		(sum, i) => sum + (i.promptTokens ?? 0) + (i.completionTokens ?? 0),
		0,
	)

	return (
		<div className="h-full flex flex-col gap-4">
			{/* Summary */}
			<div className="flex items-center gap-6 text-sm shrink-0">
				<span className="text-slate-600">
					<span className="font-medium text-slate-900">{total}</span> items
				</span>
				<span className="flex items-center gap-1">
					<span className="w-2 h-2 rounded-full bg-violet-500" />
					<span className="text-slate-600">{llmCount} LLM</span>
				</span>
				<span className="flex items-center gap-1">
					<span className="w-2 h-2 rounded-full bg-emerald-500" />
					<span className="text-slate-600">{toolCount} Tools</span>
				</span>
				<span className="flex items-center gap-1">
					<span className="w-2 h-2 rounded-full bg-amber-500" />
					<span className="text-slate-600">{compactionCount} Compactions</span>
				</span>
				<span className="text-slate-600">
					<span className="font-medium text-slate-900">{totalTokens.toLocaleString()}</span> tokens
				</span>
				{totalCost > 0 && (
					<span className="text-slate-600">
						<span className="font-medium text-green-600">${totalCost.toFixed(4)}</span> cost
					</span>
				)}
			</div>

			{/* Error */}
			{error && <div className="text-red-500 text-sm shrink-0">{error}</div>}

			{/* Loading */}
			{isLoading && items.length === 0 && <div className="text-slate-500 text-sm">Loading timeline...</div>}

			{/* Two-column layout */}
			{items.length > 0 && (
				<div className="flex-1 flex gap-4 min-h-0">
					{/* List */}
					<div className="w-96 shrink-0 bg-white rounded-md border border-slate-200 flex flex-col">
						<div className="p-3 border-b border-slate-200 shrink-0">
							<h3 className="font-medium text-slate-900">Event Timeline</h3>
						</div>
						<div className="flex-1 overflow-auto p-3">
							<TimelineList
								items={items}
								selectedId={selectedId}
								onSelect={setSelectedId}
							/>
						</div>
					</div>

					{/* Detail */}
					<div className="flex-1 bg-white rounded-md border border-slate-200 flex flex-col min-w-0">
						<div className="p-3 border-b border-slate-200 shrink-0">
							<h3 className="font-medium text-slate-900">Detail Inspector</h3>
						</div>
						<div className="flex-1 overflow-auto p-4">
							{selectedItem ? <TimelineDetail sessionId={sessionId} item={selectedItem} /> : (
								<div className="text-slate-500 text-sm">
									Select an item from the timeline to view details
								</div>
							)}
						</div>
					</div>
				</div>
			)}

			{/* Empty state */}
			{!isLoading && items.length === 0 && <div className="text-slate-500 text-sm">No timeline items found</div>}
		</div>
	)
}

function TimelineList({
	items,
	selectedId,
	onSelect,
}: {
	items: TimelineItem[]
	selectedId: string | null
	onSelect: (id: string) => void
}) {
	return (
		<div className="relative">
			{/* Vertical line */}
			<div className="absolute left-3 top-0 bottom-0 w-0.5 bg-slate-200" />

			<div className="space-y-2">
				{items.map((item) => (
					<TimelineItemRow
						key={item.id}
						item={item}
						isSelected={selectedId === item.id}
						onClick={() => onSelect(item.id)}
					/>
				))}
			</div>
		</div>
	)
}

function TimelineItemRow({
	item,
	isSelected,
	onClick,
}: {
	item: TimelineItem
	isSelected: boolean
	onClick: () => void
}) {
	const typeConfig = getTypeConfig(item.type)

	return (
		<div
			onClick={onClick}
			className={`relative pl-8 py-2 pr-3 rounded-md cursor-pointer transition-colors ${
				isSelected
					? 'bg-violet-50 border border-violet-200'
					: 'hover:bg-slate-50 border border-transparent'
			}`}
		>
			{/* Icon */}
			<div
				className={`absolute left-1 top-3 w-5 h-5 rounded-full flex items-center justify-center ${
					item.status === 'running'
						? `${typeConfig.bgLight} animate-pulse`
						: item.status === 'error'
						? 'bg-red-100'
						: typeConfig.bgLight
				}`}
			>
				{item.status === 'running'
					? <span className="w-2 h-2 rounded-full bg-blue-500" />
					: item.status === 'error'
					? <span className="text-red-500 text-xs">!</span>
					: <typeConfig.Icon />}
			</div>

			{/* Content */}
			<div className="min-w-0">
				{/* Header */}
				<div className="flex items-center gap-2">
					<span className="font-mono text-xs text-slate-500">
						{new Date(item.startedAt).toLocaleTimeString()}
					</span>
					<TypeBadge type={item.type} />
					{item.status === 'running' && <span className="text-xs text-violet-600 font-medium">Running...</span>}
					{item.status === 'error' && <span className="text-xs text-red-600 font-medium">Error</span>}
				</div>

				{/* Name/Model */}
				<div className="mt-1 font-medium text-sm truncate">
					{item.type === 'llm' && (item.model?.split('/').pop() ?? 'LLM Call')}
					{item.type === 'tool' && (item.toolName ?? 'Tool')}
					{item.type === 'compaction' && 'Context Compaction'}
				</div>

				{/* Agent */}
				<div className="text-xs text-slate-500">
					<DebugLink
						to={`agents/${item.agentId}`}
						className="hover:text-violet-600 hover:underline"
					>
						{item.agentName}
					</DebugLink>
				</div>

				{/* Metrics */}
				<div className="mt-1 flex items-center gap-3 text-xs text-slate-500">
					{item.durationMs !== undefined && <span>{(item.durationMs / 1000).toFixed(2)}s</span>}
					{item.type === 'llm' && item.promptTokens !== undefined && (
						<span>
							<span className="text-green-600">{item.promptTokens}</span>
							<span className="text-slate-400">/</span>
							<span className="text-violet-600">{item.completionTokens ?? 0}</span>
						</span>
					)}
					{item.type === 'llm' && item.cost !== undefined && <span className="text-green-600">${item.cost.toFixed(5)}</span>}
				</div>
			</div>
		</div>
	)
}

function TimelineDetail({
	sessionId,
	item,
}: {
	sessionId: string
	item: TimelineItem
}) {
	// For LLM items with llmCallId, embed the full LLMCallDetail
	if (item.type === 'llm' && item.llmCallId) {
		return (
			<div className="space-y-4">
				{/* Header with link */}
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-3">
						<TypeBadge type={item.type} />
						<span className="font-medium">{item.model?.split('/').pop() ?? 'LLM Call'}</span>
						{item.status === 'error' && <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-medium">Error</span>}
						{item.status === 'running' && (
							<span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-medium animate-pulse">Running</span>
						)}
					</div>
					<DebugLink
						to={`llm-calls/${item.llmCallId}`}
						className="text-sm text-violet-600 hover:underline"
					>
						Open full page →
					</DebugLink>
				</div>

				{/* Embedded LLM Call Detail */}
				<LLMCallDetail sessionId={sessionId} callId={item.llmCallId} />
			</div>
		)
	}

	// For LLM items without llmCallId, show what we have from the timeline item
	if (item.type === 'llm') {
		return (
			<div className="space-y-4">
				{/* Header */}
				<div className="flex items-center gap-3">
					<TypeBadge type={item.type} />
					<span className="font-medium">{item.model?.split('/').pop() ?? 'LLM Call'}</span>
					{item.status === 'error' && <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-medium">Error</span>}
					{item.status === 'running' && (
						<span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-medium animate-pulse">Running</span>
					)}
				</div>

				{/* LLM Metrics */}
				<div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
					<MetricCard label="Agent">
						<DebugLink
							to={`agents/${item.agentId}`}
							className="text-violet-600 hover:underline"
						>
							{item.agentName}
						</DebugLink>
					</MetricCard>
					{item.model && (
						<MetricCard label="Model">
							<span className="font-mono text-xs">{item.model}</span>
						</MetricCard>
					)}
					{item.durationMs !== undefined && <MetricCard label="Duration">{(item.durationMs / 1000).toFixed(2)}s</MetricCard>}
					{item.cost !== undefined && (
						<MetricCard label="Cost">
							<span className="text-green-600">${item.cost.toFixed(6)}</span>
						</MetricCard>
					)}
				</div>

				{/* Token breakdown */}
				{(item.promptTokens !== undefined || item.completionTokens !== undefined) && (
					<div className="bg-violet-50 border border-violet-200 rounded-md p-4">
						<h3 className="font-medium text-violet-800 mb-3">Token Usage</h3>
						<div className="grid grid-cols-3 gap-4 text-sm">
							<div>
								<div className="text-xs text-violet-600 mb-1">Prompt</div>
								<div className="font-mono font-medium text-green-600">
									{(item.promptTokens ?? 0).toLocaleString()}
								</div>
							</div>
							<div>
								<div className="text-xs text-violet-600 mb-1">Completion</div>
								<div className="font-mono font-medium text-violet-600">
									{(item.completionTokens ?? 0).toLocaleString()}
								</div>
							</div>
							<div>
								<div className="text-xs text-violet-600 mb-1">Total</div>
								<div className="font-mono font-medium">
									{((item.promptTokens ?? 0) + (item.completionTokens ?? 0)).toLocaleString()}
								</div>
							</div>
						</div>
					</div>
				)}

				{/* Timestamps */}
				<div className="text-xs text-slate-500 space-y-1">
					<div>Started: {new Date(item.startedAt).toLocaleString()}</div>
					{item.completedAt && <div>Completed: {new Date(item.completedAt).toLocaleString()}</div>}
				</div>

				{/* Error */}
				{item.error && (
					<div className="bg-red-50 border border-red-200 rounded-md p-4">
						<h3 className="font-semibold text-red-800 mb-2">Error</h3>
						<div className="text-red-700 font-mono text-sm whitespace-pre-wrap">{item.error}</div>
					</div>
				)}

				{/* Note about missing detailed log */}
				<div className="text-xs text-slate-400 italic">
					Detailed request/response log not available for this call.
				</div>
			</div>
		)
	}

	// Tool detail
	if (item.type === 'tool') {
		return (
			<div className="space-y-4">
				{/* Header */}
				<div className="flex items-center gap-3">
					<TypeBadge type={item.type} />
					<span className="font-medium font-mono">{item.toolName ?? 'Tool'}</span>
					{item.status === 'error' && <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-medium">Error</span>}
					{item.status === 'running' && (
						<span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-medium animate-pulse">Running</span>
					)}
				</div>

				{/* Metrics */}
				<div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
					<MetricCard label="Agent">
						<DebugLink
							to={`agents/${item.agentId}`}
							className="text-violet-600 hover:underline"
						>
							{item.agentName}
						</DebugLink>
					</MetricCard>
					{item.durationMs !== undefined && <MetricCard label="Duration">{(item.durationMs / 1000).toFixed(2)}s</MetricCard>}
					<MetricCard label="Started">
						{new Date(item.startedAt).toLocaleTimeString()}
					</MetricCard>
					{item.completedAt && (
						<MetricCard label="Completed">
							{new Date(item.completedAt).toLocaleTimeString()}
						</MetricCard>
					)}
				</div>

				{/* Input */}
				{item.toolInput !== undefined && (
					<div className="border border-slate-200 rounded-md overflow-hidden">
						<div className="px-4 py-2 bg-slate-50 border-b border-slate-200">
							<h3 className="text-sm font-medium text-slate-700">Input</h3>
						</div>
						<div className="p-4 max-h-64 overflow-auto">
							<pre className="font-mono text-xs whitespace-pre-wrap break-words">
                {JSON.stringify(item.toolInput, null, 2)}
							</pre>
						</div>
					</div>
				)}

				{/* Result */}
				{item.toolResult !== undefined && (
					<div className="border border-emerald-200 rounded-md overflow-hidden">
						<div className="px-4 py-2 bg-emerald-50 border-b border-emerald-200">
							<h3 className="text-sm font-medium text-emerald-700">Result</h3>
						</div>
						<div className="p-4 max-h-64 overflow-auto">
							<pre className="font-mono text-xs whitespace-pre-wrap break-words">
                {JSON.stringify(item.toolResult, null, 2)}
							</pre>
						</div>
					</div>
				)}

				{/* Error */}
				{item.error && (
					<div className="bg-red-50 border border-red-200 rounded-md p-4">
						<h3 className="font-semibold text-red-800 mb-2">Error</h3>
						<div className="text-red-700 font-mono text-sm whitespace-pre-wrap">{item.error}</div>
					</div>
				)}
			</div>
		)
	}

	// Compaction detail
	if (item.type === 'compaction') {
		return (
			<div className="space-y-4">
				{/* Header */}
				<div className="flex items-center gap-3">
					<TypeBadge type={item.type} />
					<span className="font-medium">Context Compaction</span>
				</div>

				{/* Metrics */}
				<div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
					<MetricCard label="Agent">
						<DebugLink
							to={`agents/${item.agentId}`}
							className="text-violet-600 hover:underline"
						>
							{item.agentName}
						</DebugLink>
					</MetricCard>
					{item.originalTokens !== undefined && (
						<MetricCard label="Original Tokens">
							{item.originalTokens.toLocaleString()}
						</MetricCard>
					)}
					{item.compactedTokens !== undefined && (
						<MetricCard label="Compacted Tokens">
							{item.compactedTokens.toLocaleString()}
						</MetricCard>
					)}
					{item.messagesRemoved !== undefined && (
						<MetricCard label="Messages Removed">
							{item.messagesRemoved}
						</MetricCard>
					)}
				</div>

				{/* Reduction visualization */}
				{item.originalTokens !== undefined && item.compactedTokens !== undefined && (
					<div className="bg-amber-50 border border-amber-200 rounded-md p-4">
						<h3 className="font-medium text-amber-800 mb-3">Compression</h3>
						<div className="flex items-center gap-4">
							<div className="text-2xl font-bold text-amber-600">
								{Math.round((1 - item.compactedTokens / item.originalTokens) * 100)}%
							</div>
							<div className="text-sm text-amber-700">
								reduced ({item.originalTokens.toLocaleString()} → {item.compactedTokens.toLocaleString()} tokens)
							</div>
						</div>
					</div>
				)}

				{/* Timestamp */}
				<div className="text-xs text-slate-500">
					Compacted at: {new Date(item.startedAt).toLocaleString()}
				</div>
			</div>
		)
	}

	// Fallback (shouldn't happen)
	return <div className="text-slate-500 text-sm">Unknown item type</div>
}

function MetricCard({
	label,
	children,
}: {
	label: string
	children: React.ReactNode
}) {
	return (
		<div className="bg-slate-50 rounded-md p-3">
			<div className="text-xs text-slate-500 mb-1">{label}</div>
			<div className="font-medium text-slate-900">{children}</div>
		</div>
	)
}

function TypeBadge({ type }: { type: TimelineItem['type'] }) {
	const config = getTypeConfig(type)
	return (
		<span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${config.badge}`}>
			{config.label}
		</span>
	)
}

interface TypeConfig {
	label: string
	badge: string
	bgLight: string
	Icon: () => React.ReactNode
}

function getTypeConfig(type: TimelineItem['type']): TypeConfig {
	switch (type) {
		case 'llm':
			return {
				label: 'LLM',
				badge: 'bg-violet-100 text-violet-700',
				bgLight: 'bg-violet-100',
				Icon: LLMIcon,
			}
		case 'tool':
			return {
				label: 'Tool',
				badge: 'bg-emerald-100 text-emerald-700',
				bgLight: 'bg-emerald-100',
				Icon: ToolIcon,
			}
		case 'compaction':
			return {
				label: 'Compact',
				badge: 'bg-amber-100 text-amber-700',
				bgLight: 'bg-amber-100',
				Icon: CompactionIcon,
			}
	}
}

function LLMIcon() {
	return (
		<svg className="w-3 h-3 text-violet-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={2}
				d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
			/>
		</svg>
	)
}

function ToolIcon() {
	return (
		<svg className="w-3 h-3 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={2}
				d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
			/>
			<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
		</svg>
	)
}

function CompactionIcon() {
	return (
		<svg className="w-3 h-3 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={2}
				d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4"
			/>
		</svg>
	)
}
