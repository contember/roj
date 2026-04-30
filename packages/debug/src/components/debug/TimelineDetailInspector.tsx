import type { TimelineItem } from '@roj-ai/shared'
import { LLMCallDetail } from './LLMCallDetail.js'

export function TimelineDetailInspector({
	sessionId,
	item,
	onNavigate,
}: {
	sessionId: string
	item: TimelineItem
	onNavigate?: (path: string) => void
}) {
	const agentLink = (agentId: string, name: string) =>
		onNavigate
			? (
				<button type="button" onClick={() => onNavigate(`agents/${agentId}`)} className="text-violet-600 hover:underline cursor-pointer">
					{name}
				</button>
			)
			: <span>{name}</span>

	// LLM with detailed call log
	if (item.type === 'llm' && item.llmCallId) {
		return (
			<div className="space-y-4">
				<div className="flex items-center gap-3">
					<TypeBadge type={item.type} />
					<span className="font-medium">{item.model?.split('/').pop() ?? 'LLM Call'}</span>
					<StatusBadge status={item.status} />
				</div>
				<LLMCallDetail sessionId={sessionId} callId={item.llmCallId} />
			</div>
		)
	}

	// LLM without detailed log
	if (item.type === 'llm') {
		return (
			<div className="space-y-4">
				<div className="flex items-center gap-3">
					<TypeBadge type={item.type} />
					<span className="font-medium">{item.model?.split('/').pop() ?? 'LLM Call'}</span>
					<StatusBadge status={item.status} />
				</div>

				<div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
					<MetricCard label="Agent">{agentLink(item.agentId, item.agentName)}</MetricCard>
					{item.model && <MetricCard label="Model"><span className="font-mono text-xs">{item.model}</span></MetricCard>}
					{item.durationMs !== undefined && <MetricCard label="Duration">{(item.durationMs / 1000).toFixed(2)}s</MetricCard>}
					{item.cost !== undefined && <MetricCard label="Cost"><span className="text-green-600">${item.cost.toFixed(6)}</span></MetricCard>}
				</div>

				{(item.promptTokens !== undefined || item.completionTokens !== undefined) && (
					<div className="bg-violet-50 border border-violet-200 rounded-md p-4">
						<h3 className="font-medium text-violet-800 mb-3">Token Usage</h3>
						<div className="grid grid-cols-3 gap-4 text-sm">
							<div>
								<div className="text-xs text-violet-600 mb-1">Prompt</div>
								<div className="font-mono font-medium text-green-600">{(item.promptTokens ?? 0).toLocaleString()}</div>
							</div>
							<div>
								<div className="text-xs text-violet-600 mb-1">Completion</div>
								<div className="font-mono font-medium text-violet-600">{(item.completionTokens ?? 0).toLocaleString()}</div>
							</div>
							<div>
								<div className="text-xs text-violet-600 mb-1">Total</div>
								<div className="font-mono font-medium">{((item.promptTokens ?? 0) + (item.completionTokens ?? 0)).toLocaleString()}</div>
							</div>
						</div>
					</div>
				)}

				<div className="text-xs text-slate-500 space-y-1">
					<div>Started: {new Date(item.startedAt).toLocaleString()}</div>
					{item.completedAt && <div>Completed: {new Date(item.completedAt).toLocaleString()}</div>}
				</div>

				{item.error && (
					<div className="bg-red-50 border border-red-200 rounded-md p-4">
						<h3 className="font-semibold text-red-800 mb-2">Error</h3>
						<div className="text-red-700 font-mono text-sm whitespace-pre-wrap">{item.error}</div>
					</div>
				)}
			</div>
		)
	}

	// Tool
	if (item.type === 'tool') {
		return (
			<div className="space-y-4">
				<div className="flex items-center gap-3">
					<TypeBadge type={item.type} />
					<span className="font-medium font-mono">{item.toolName ?? 'Tool'}</span>
					<StatusBadge status={item.status} />
				</div>

				<div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
					<MetricCard label="Agent">{agentLink(item.agentId, item.agentName)}</MetricCard>
					{item.durationMs !== undefined && <MetricCard label="Duration">{(item.durationMs / 1000).toFixed(2)}s</MetricCard>}
					<MetricCard label="Started">{new Date(item.startedAt).toLocaleTimeString()}</MetricCard>
					{item.completedAt && <MetricCard label="Completed">{new Date(item.completedAt).toLocaleTimeString()}</MetricCard>}
				</div>

				{item.toolInput !== undefined && (
					<div className="border border-slate-200 rounded-md overflow-hidden">
						<div className="px-4 py-2 bg-slate-50 border-b border-slate-200">
							<h3 className="text-sm font-medium text-slate-700">Input</h3>
						</div>
						<div className="p-4 max-h-64 overflow-auto">
							<pre className="font-mono text-xs whitespace-pre-wrap break-words">{JSON.stringify(item.toolInput, null, 2)}</pre>
						</div>
					</div>
				)}

				{item.toolResult !== undefined && (
					<div className="border border-emerald-200 rounded-md overflow-hidden">
						<div className="px-4 py-2 bg-emerald-50 border-b border-emerald-200">
							<h3 className="text-sm font-medium text-emerald-700">Result</h3>
						</div>
						<div className="p-4 max-h-64 overflow-auto">
							<pre className="font-mono text-xs whitespace-pre-wrap break-words">{JSON.stringify(item.toolResult, null, 2)}</pre>
						</div>
					</div>
				)}

				{item.error && (
					<div className="bg-red-50 border border-red-200 rounded-md p-4">
						<h3 className="font-semibold text-red-800 mb-2">Error</h3>
						<div className="text-red-700 font-mono text-sm whitespace-pre-wrap">{item.error}</div>
					</div>
				)}
			</div>
		)
	}

	// Compaction
	if (item.type === 'compaction') {
		return (
			<div className="space-y-4">
				<div className="flex items-center gap-3">
					<TypeBadge type={item.type} />
					<span className="font-medium">Context Compaction</span>
				</div>

				<div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
					<MetricCard label="Agent">{agentLink(item.agentId, item.agentName)}</MetricCard>
					{item.originalTokens !== undefined && <MetricCard label="Original Tokens">{item.originalTokens.toLocaleString()}</MetricCard>}
					{item.compactedTokens !== undefined && <MetricCard label="Compacted Tokens">{item.compactedTokens.toLocaleString()}</MetricCard>}
					{item.messagesRemoved !== undefined && <MetricCard label="Messages Removed">{item.messagesRemoved}</MetricCard>}
				</div>

				{item.originalTokens !== undefined && item.compactedTokens !== undefined && (
					<div className="bg-amber-50 border border-amber-200 rounded-md p-4">
						<h3 className="font-medium text-amber-800 mb-3">Compression</h3>
						<div className="flex items-center gap-4">
							<div className="text-2xl font-bold text-amber-600">
								{Math.round((1 - item.compactedTokens / item.originalTokens) * 100)}%
							</div>
							<div className="text-sm text-amber-700">
								reduced ({item.originalTokens.toLocaleString()} &rarr; {item.compactedTokens.toLocaleString()} tokens)
							</div>
						</div>
					</div>
				)}

				<div className="text-xs text-slate-500">
					Compacted at: {new Date(item.startedAt).toLocaleString()}
				</div>
			</div>
		)
	}

	return <div className="text-slate-500 text-sm">Unknown item type</div>
}

function StatusBadge({ status }: { status: string }) {
	if (status === 'error') return <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-medium">Error</span>
	if (status === 'running') return <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-medium animate-pulse">Running</span>
	return null
}

function TypeBadge({ type }: { type: TimelineItem['type'] }) {
	const config: Record<TimelineItem['type'], string> = {
		llm: 'bg-violet-100 text-violet-700',
		tool: 'bg-emerald-100 text-emerald-700',
		compaction: 'bg-amber-100 text-amber-700',
	}
	const labels: Record<TimelineItem['type'], string> = {
		llm: 'LLM',
		tool: 'Tool',
		compaction: 'Compact',
	}
	return <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${config[type]}`}>{labels[type]}</span>
}

function MetricCard({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="bg-slate-50 rounded-md p-3">
			<div className="text-xs text-slate-500 mb-1">{label}</div>
			<div className="font-medium text-slate-900">{children}</div>
		</div>
	)
}
