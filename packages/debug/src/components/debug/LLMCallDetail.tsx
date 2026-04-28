import type { ChatMessageContentItem, LLMCallLogEntry, LLMCallMessage } from '@roj-ai/sdk'
import { estimateTokens } from '../../lib/domain-utils.js'
import { useEffect, useMemo, useState } from 'react'
import { api, getApiBaseUrl, unwrap } from '@roj-ai/client'

function isLLMCallLogEntry(data: unknown): data is LLMCallLogEntry {
	return typeof data === 'object' && data !== null && 'id' in data && 'status' in data && 'request' in data
}

interface LLMCallDetailProps {
	sessionId: string
	callId: string
	onClose?: () => void
}

export function LLMCallDetail({ sessionId, callId, onClose }: LLMCallDetailProps) {
	const [call, setCall] = useState<LLMCallLogEntry | null>(null)
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		let cancelled = false

		const load = async () => {
			try {
				setLoading(true)
				setError(null)
				const data = unwrap(await api.call('llm.getCall', { sessionId, callId }))
				if (!cancelled && isLLMCallLogEntry(data)) {
					setCall(data)
				}
			} catch (err) {
				if (!cancelled) {
					setError(err instanceof Error ? err.message : 'Failed to load LLM call')
				}
			} finally {
				if (!cancelled) {
					setLoading(false)
				}
			}
		}

		load()

		return () => {
			cancelled = true
		}
	}, [sessionId, callId])

	if (loading) {
		return <div className="text-slate-500 text-sm p-4">Loading...</div>
	}

	if (error) {
		return <div className="text-red-500 text-sm p-4">{error}</div>
	}

	if (!call) {
		return <div className="text-slate-500 text-sm p-4">No data</div>
	}

	return (
		<div className="space-y-6 text-sm">
			{/* Header */}
			<div className="flex items-center justify-between border-b pb-4">
				<div className="flex items-center gap-3">
					<StatusBadge status={call.status} />
					<span className="font-mono font-medium text-lg">{call.request.model}</span>
				</div>
				{onClose && (
					<button
						onClick={onClose}
						className="text-slate-400 hover:text-slate-600 text-xl"
					>
						×
					</button>
				)}
			</div>

			{/* Metrics Grid (4 tiles) */}
			<MetricsGrid call={call} />

			{/* Error */}
			{call.error && (
				<div className="bg-red-50 border border-red-200 rounded-md p-4">
					<h3 className="font-semibold text-red-800 mb-2">Error</h3>
					<div className="font-medium text-red-700">{call.error.type}</div>
					<div className="text-red-600">{call.error.message}</div>
					{call.error.retryAfterMs !== undefined && (
						<div className="text-red-500 text-xs mt-1">
							Retry after: {call.error.retryAfterMs}ms
						</div>
					)}
				</div>
			)}

			{/* Main Content - Two Column Layout */}
			<div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
				{/* Left: Messages */}
				<div className="lg:col-span-2 space-y-4">
					{/* System Prompt */}
					<CollapsibleSection title="System Prompt" defaultOpen={false}>
						<CollapsibleContent maxLines={10}>
							{call.request.systemPrompt}
						</CollapsibleContent>
					</CollapsibleSection>

					{/* Messages */}
					<CollapsibleSection
						title={`Messages (${call.request.messages.length})`}
						defaultOpen={true}
					>
						<div className="space-y-3">
							{call.request.messages.map((msg, idx) => (
								<div key={idx}>
									<MessageBlock message={msg} index={idx} sessionId={sessionId} />
									{msg.cacheControl && <CacheBreakpointMarker />}
								</div>
							))}

							{/* Response */}
							{call.response && (
								<div className="border-t-2 border-green-300 pt-3">
									<div className="text-xs text-green-600 font-medium mb-2">Response</div>

									{/* Reasoning (orange box) */}
									{call.response.reasoning && (
										<div className="bg-orange-50 border border-orange-200 rounded-md p-3 mb-3">
											<div className="text-sm font-semibold text-orange-800 mb-2">Reasoning:</div>
											<CollapsibleContent maxLines={20}>
												{call.response.reasoning}
											</CollapsibleContent>
										</div>
									)}

									{/* Content */}
									{call.response.content && (
										<div className="bg-green-50 border border-green-200 rounded-md p-3 mb-3">
											<CollapsibleContent maxLines={15}>
												{call.response.content}
											</CollapsibleContent>
										</div>
									)}

									{/* Tool Calls */}
									{call.response.toolCalls.length > 0 && (
										<div className="space-y-2">
											<div className="text-xs font-medium text-slate-600">Tool Calls:</div>
											{call.response.toolCalls.map((tc) => (
												<div
													key={tc.id}
													className="bg-cyan-50 border border-cyan-200 rounded-md p-3"
												>
													<div className="flex items-center gap-2 mb-2">
														<span className="font-mono font-medium text-cyan-800">{tc.name}</span>
														<span className="text-xs text-cyan-600 font-mono bg-cyan-100 px-2 py-0.5 rounded">
															{tc.id.slice(0, 8)}
														</span>
													</div>
													<CollapsibleContent maxLines={10}>
														{JSON.stringify(tc.input, null, 2)}
													</CollapsibleContent>
												</div>
											))}
										</div>
									)}

									{/* Finish Reason */}
									<div className="mt-2 flex items-center gap-2">
										<span className="text-xs text-slate-500">Finish reason:</span>
										<FinishReasonBadge reason={call.response.finishReason} />
									</div>
								</div>
							)}
						</div>
					</CollapsibleSection>
				</div>

				{/* Right: Sidebar */}
				<div className="space-y-4">
					{/* Token Usage Details */}
					{call.metrics && (
						<SidebarPanel title="Token Details">
							<div className="space-y-2">
								<MetricRow label="Prompt" value={call.metrics.promptTokens.toLocaleString()} color="text-green-600" />
								<MetricRow label="Completion" value={call.metrics.completionTokens.toLocaleString()} color="text-violet-600" />
								{call.metrics.reasoningTokens !== undefined && (
									<MetricRow label="Reasoning" value={call.metrics.reasoningTokens.toLocaleString()} color="text-purple-600" />
								)}
								{call.metrics.cachedTokens !== undefined && (
									<MetricRow label="Cached" value={call.metrics.cachedTokens.toLocaleString()} color="text-slate-500" />
								)}
								<div className="border-t pt-2">
									<MetricRow label="Total" value={call.metrics.totalTokens.toLocaleString()} color="text-slate-900" bold />
								</div>
							</div>
						</SidebarPanel>
					)}

					{/* Tools */}
					{call.request.tools && call.request.tools.length > 0 && (
						<SidebarPanel title={`Tools (${call.request.toolsCount})`}>
							<div className="space-y-2 max-h-96 overflow-y-auto">
								{call.request.tools.map((tool) => (
									<details key={tool.name} className="bg-slate-50 rounded border">
										<summary className="p-2 cursor-pointer hover:bg-slate-100 text-xs">
											<span className="font-mono font-medium">{tool.name}</span>
										</summary>
										<div className="p-2 border-t text-xs space-y-2">
											<div className="text-slate-600">{tool.description}</div>
											{tool.parameters && (
												<details className="bg-white rounded border">
													<summary className="p-2 cursor-pointer hover:bg-slate-50 text-xs font-medium text-violet-600">
														JSON Schema
													</summary>
													<div className="p-2 border-t">
														<pre className="text-xs font-mono text-slate-700 whitespace-pre-wrap overflow-x-auto max-h-64 overflow-y-auto">
                              {JSON.stringify(tool.parameters, null, 2)}
														</pre>
													</div>
												</details>
											)}
										</div>
									</details>
								))}
							</div>
						</SidebarPanel>
					)}

					{/* Request Info */}
					<SidebarPanel title="Request Info">
						<div className="space-y-2 text-xs">
							<div>
								<span className="text-slate-500">Created:</span> <span className="font-mono">{new Date(call.createdAt).toLocaleString()}</span>
							</div>
							{call.completedAt && (
								<div>
									<span className="text-slate-500">Completed:</span> <span className="font-mono">{new Date(call.completedAt).toLocaleString()}</span>
								</div>
							)}
							<div>
								<span className="text-slate-500">Agent:</span> <span className="font-mono">{call.agentId.slice(0, 12)}...</span>
							</div>
						</div>
					</SidebarPanel>
				</div>
			</div>
		</div>
	)
}

// ============================================================================
// Collapsible Content Component
// ============================================================================

function CollapsibleContent({ children, maxLines = 10 }: { children: string; maxLines?: number }) {
	const [isExpanded, setIsExpanded] = useState(false)

	const { lines, shouldCollapse, tokenCount } = useMemo(() => {
		const content = children
		const lines = content.split('\n')
		return {
			lines,
			shouldCollapse: lines.length > maxLines,
			tokenCount: estimateTokens(content),
		}
	}, [children, maxLines])

	if (!shouldCollapse) {
		return (
			<div className="space-y-2">
				<pre className="font-mono text-xs whitespace-pre-wrap break-words">{children}</pre>
				<div className="flex justify-end">
					<TokenCountBadge count={tokenCount} />
				</div>
			</div>
		)
	}

	return (
		<div className="space-y-2">
			<div className={`relative ${!isExpanded ? 'max-h-64 overflow-hidden' : ''}`}>
				<pre className="font-mono text-xs whitespace-pre-wrap break-words">
          {isExpanded ? children : lines.slice(0, maxLines).join('\n')}
				</pre>
				{!isExpanded && <div className="absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-white to-transparent pointer-events-none" />}
			</div>
			<div className="flex items-center justify-between">
				<button
					onClick={() => setIsExpanded(!isExpanded)}
					className="px-3 py-1 text-xs bg-violet-100 hover:bg-violet-200 text-violet-800 rounded transition-colors"
				>
					{isExpanded ? 'Show less' : `Show all (${lines.length} lines)`}
				</button>
				<TokenCountBadge count={tokenCount} />
			</div>
		</div>
	)
}

// ============================================================================
// Helper Components
// ============================================================================

function CollapsibleSection({
	title,
	defaultOpen,
	children,
}: {
	title: string
	defaultOpen: boolean
	children: React.ReactNode
}) {
	const [open, setOpen] = useState(defaultOpen)

	return (
		<div className="border border-slate-200 rounded-md overflow-hidden">
			<button
				onClick={() => setOpen(!open)}
				className="w-full px-4 py-3 text-left flex items-center justify-between bg-slate-50 hover:bg-slate-100 transition-colors"
			>
				<span className="font-medium text-slate-700">{title}</span>
				<span className="text-slate-400 text-lg">{open ? '−' : '+'}</span>
			</button>
			{open && <div className="p-4 border-t border-slate-200">{children}</div>}
		</div>
	)
}

/**
 * Convert a file:// URL to the session file proxy endpoint.
 * Handles both real paths (file:///.../.roj/data/sessions/{id}/foo.png)
 * and virtual/sandboxed paths (file:///home/user/session/foo.png).
 */
function fileUrlToProxyUrl(fileUrl: string, sessionId: string): string {
	const baseUrl = getApiBaseUrl()

	// Try real path: extract after /sessions/{sessionId}/
	const sessionMarker = `/sessions/${sessionId}/`
	const idx = fileUrl.indexOf(sessionMarker)
	if (idx !== -1) {
		const relativePath = fileUrl.slice(idx + sessionMarker.length)
		return `${baseUrl}/sessions/${sessionId}/files/${relativePath}`
	}

	// Try virtual/sandboxed path: /home/user/session/...
	const virtualPrefix = 'file:///home/user/session/'
	if (fileUrl.startsWith(virtualPrefix)) {
		const relativePath = fileUrl.slice(virtualPrefix.length)
		return `${baseUrl}/sessions/${sessionId}/files/${relativePath}`
	}

	return fileUrl
}

function MessageContentItems({ items, sessionId }: { items: ChatMessageContentItem[]; sessionId: string }) {
	const textContent = items.filter((it): it is ChatMessageContentItem & { type: 'text' } => it.type === 'text').map((it) => it.text).join('\n')
	const images = items.filter((it): it is ChatMessageContentItem & { type: 'image_url' } => it.type === 'image_url')

	return (
		<>
			{textContent && <CollapsibleContent maxLines={10}>{textContent}</CollapsibleContent>}
			{images.length > 0 && (
				<div className="mt-2 flex flex-wrap gap-2">
					{images.map((img, i) => (
						<a key={i} href={fileUrlToProxyUrl(img.imageUrl.url, sessionId)} target="_blank" rel="noopener noreferrer">
							<img
								src={fileUrlToProxyUrl(img.imageUrl.url, sessionId)}
								alt="Tool result image"
								className="max-w-64 max-h-48 rounded border border-slate-300 object-contain"
							/>
						</a>
					))}
				</div>
			)}
		</>
	)
}

function MessageBlock({ message, index, sessionId }: { message: LLMCallMessage; index: number; sessionId: string }) {
	const roleColors: Record<string, string> = {
		user: 'bg-blue-50 border-blue-200',
		assistant: 'bg-green-50 border-green-200',
		tool: 'bg-purple-50 border-purple-200',
		system: 'bg-yellow-50 border-yellow-200',
	}

	return (
		<div className={`p-3 rounded-md border ${roleColors[message.role] || 'bg-slate-50 border-slate-200'}`}>
			<div className="flex items-center gap-2 mb-2">
				<RoleBadge role={message.role} />
				<span className="text-xs text-slate-500 font-mono">#{index + 1}</span>
				{message.toolCallId && (
					<span className="text-xs text-slate-500 font-mono bg-slate-100 px-1 rounded">
						{message.toolCallId.slice(0, 8)}
					</span>
				)}
			</div>

			{/* Reasoning for assistant messages */}
			{message.reasoning && (
				<div className="bg-orange-50 border border-orange-200 rounded p-2 mb-2">
					<div className="text-xs font-semibold text-orange-800 mb-1">Reasoning:</div>
					<CollapsibleContent maxLines={10}>{message.reasoning}</CollapsibleContent>
				</div>
			)}

			{/* Content */}
			{typeof message.content === 'string'
				? <CollapsibleContent maxLines={10}>{message.content}</CollapsibleContent>
				: <MessageContentItems items={message.content} sessionId={sessionId} />}

			{/* Tool Calls */}
			{message.toolCalls && message.toolCalls.length > 0 && (
				<div className="mt-3 space-y-2">
					<div className="text-xs font-medium text-slate-600">Tool Calls:</div>
					{message.toolCalls.map((tc) => (
						<div key={tc.id} className="bg-white rounded border p-2">
							<div className="flex items-center gap-2 mb-1">
								<span className="font-mono text-xs font-medium">{tc.name}</span>
								<span className="text-xs text-slate-500 font-mono">{tc.id.slice(0, 8)}</span>
							</div>
							<pre className="text-xs text-slate-600 overflow-x-auto">
                {JSON.stringify(tc.input, null, 2)}
							</pre>
						</div>
					))}
				</div>
			)}
		</div>
	)
}

function MetricTile({
	icon,
	iconBg,
	iconColor,
	title,
	children,
}: {
	icon: React.ReactNode
	iconBg: string
	iconColor: string
	title: string
	children: React.ReactNode
}) {
	return (
		<div className="bg-white rounded-md border border-slate-200 p-4">
			<div className="flex items-center gap-2 mb-3">
				<div className={`w-8 h-8 ${iconBg} rounded-full flex items-center justify-center`}>
					<span className={iconColor}>{icon}</span>
				</div>
				<h3 className="text-xs font-medium text-slate-500">{title}</h3>
			</div>
			{children}
		</div>
	)
}

function SidebarPanel({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<div className="bg-white rounded-md border border-slate-200">
			<div className="px-4 py-2 border-b border-slate-200 bg-slate-50">
				<h3 className="text-xs font-semibold text-slate-700">{title}</h3>
			</div>
			<div className="px-4 py-3">{children}</div>
		</div>
	)
}

function MetricRow({
	label,
	value,
	color,
	bold,
}: {
	label: string
	value: string
	color?: string
	bold?: boolean
}) {
	return (
		<div className="flex justify-between text-xs">
			<span className="text-slate-500">{label}</span>
			<span className={`font-mono ${color || ''} ${bold ? 'font-bold' : 'font-semibold'}`}>{value}</span>
		</div>
	)
}

function TokenCountBadge({ count }: { count: number }) {
	return (
		<span className="text-xs text-violet-500 bg-violet-50 px-2 py-1 rounded-full font-mono">
			~{count.toLocaleString()} tokens
		</span>
	)
}

function StatusBadge({ status }: { status: 'running' | 'success' | 'error' }) {
	const colors: Record<string, string> = {
		running: 'bg-yellow-100 text-yellow-700',
		success: 'bg-green-100 text-green-700',
		error: 'bg-red-100 text-red-700',
	}
	return (
		<span className={`text-xs px-2 py-0.5 rounded font-medium ${colors[status]}`}>
			{status}
		</span>
	)
}

function CacheBreakpointMarker() {
	return (
		<div className="flex items-center gap-2 my-2" title="Prompt cache breakpoint — everything above is eligible for caching">
			<div className="flex-1 border-t border-dashed border-amber-400" />
			<span className="text-[10px] font-mono font-semibold text-amber-700 bg-amber-50 border border-amber-300 px-2 py-0.5 rounded uppercase tracking-wider">
				Cache Breakpoint
			</span>
			<div className="flex-1 border-t border-dashed border-amber-400" />
		</div>
	)
}

function CacheBadge({ status }: { status: 'hit' | 'miss' | 'none' }) {
	const colors: Record<string, string> = {
		hit: 'text-green-600',
		miss: 'text-orange-600',
		none: 'text-slate-500',
	}
	const labels: Record<string, string> = {
		hit: 'CACHE HIT',
		miss: 'CACHE MISS',
		none: 'NO CACHE',
	}
	return (
		<span className={`text-xs font-mono font-semibold ${colors[status]}`}>
			{labels[status]}
		</span>
	)
}

function RoleBadge({ role }: { role: string }) {
	const colors: Record<string, string> = {
		user: 'bg-blue-100 text-blue-700',
		assistant: 'bg-green-100 text-green-700',
		tool: 'bg-purple-100 text-purple-700',
		system: 'bg-yellow-100 text-yellow-700',
	}
	return (
		<span className={`text-xs px-2 py-0.5 rounded font-medium uppercase ${colors[role] || 'bg-slate-100 text-slate-700'}`}>
			{role}
		</span>
	)
}

function FinishReasonBadge({ reason }: { reason: string }) {
	const colors: Record<string, string> = {
		stop: 'bg-green-100 text-green-700',
		tool_calls: 'bg-cyan-100 text-cyan-700',
		length: 'bg-yellow-100 text-yellow-700',
		error: 'bg-red-100 text-red-700',
	}
	return (
		<span className={`text-xs px-2 py-0.5 rounded font-medium ${colors[reason] || 'bg-slate-100 text-slate-700'}`}>
			{reason}
		</span>
	)
}

// ============================================================================
// Icons (simple SVG)
// ============================================================================

function DollarIcon() {
	return (
		<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={2}
				d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
			/>
		</svg>
	)
}

function TokenIcon() {
	return (
		<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={2}
				d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
			/>
		</svg>
	)
}

function PerformanceIcon() {
	return (
		<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
		</svg>
	)
}

function ModelIcon() {
	return (
		<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={2}
				d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
			/>
		</svg>
	)
}

// ============================================================================
// Metrics Grid Component
// ============================================================================

function MetricsGrid({ call }: { call: LLMCallLogEntry }) {
	const metrics = call.metrics

	const totalCost = metrics?.cost
	const promptTokens = metrics?.promptTokens
	const completionTokens = metrics?.completionTokens
	const reasoningTokens = metrics?.reasoningTokens
	const cachedTokens = metrics?.cachedTokens
	const latency = metrics?.latencyMs
	const generationTime = metrics?.generationTimeMs
	const provider = metrics?.provider

	// Calculate total tokens
	const totalTokens = (promptTokens ?? 0) + (completionTokens ?? 0)

	// Calculate effective rate (tokens/sec)
	const tokensPerSecond = generationTime && completionTokens
		? ((completionTokens / generationTime) * 1000).toFixed(1)
		: null

	return (
		<div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
			{/* Cost Tile */}
			<MetricTile
				icon={<DollarIcon />}
				iconBg="bg-green-100"
				iconColor="text-green-600"
				title="Cost"
			>
				<div className="text-2xl font-bold text-slate-900">
					{totalCost !== undefined ? `$${totalCost.toFixed(6)}` : '—'}
				</div>
			</MetricTile>

			{/* Tokens Tile */}
			<MetricTile
				icon={<TokenIcon />}
				iconBg="bg-violet-100"
				iconColor="text-violet-600"
				title="Tokens"
			>
				<div className="text-2xl font-bold text-slate-900">
					{totalTokens.toLocaleString()}
				</div>
				<div className="flex flex-wrap gap-x-3 gap-y-1 text-xs mt-1">
					<span className="text-green-600">
						<span className="text-slate-400">In:</span> {(promptTokens ?? 0).toLocaleString()}
					</span>
					<span className="text-violet-600">
						<span className="text-slate-400">Out:</span> {(completionTokens ?? 0).toLocaleString()}
					</span>
					{reasoningTokens !== null && reasoningTokens !== undefined && reasoningTokens > 0 && (
						<span className="text-purple-600">
							<span className="text-slate-400">Reason:</span> {reasoningTokens.toLocaleString()}
						</span>
					)}
				</div>
				{cachedTokens !== null && cachedTokens !== undefined && (
					<div className="mt-2">
						<CacheBadge status={cachedTokens > 0 ? 'hit' : 'miss'} />
						{cachedTokens > 0 && (
							<span className="text-xs text-slate-500 ml-2">
								({cachedTokens.toLocaleString()} cached)
							</span>
						)}
					</div>
				)}
			</MetricTile>

			{/* Performance Tile */}
			<MetricTile
				icon={<PerformanceIcon />}
				iconBg="bg-amber-100"
				iconColor="text-amber-600"
				title="Performance"
			>
				<div className="text-2xl font-bold text-slate-900">
					{latency !== undefined && latency !== null ? `${(latency / 1000).toFixed(2)}s` : '—'}
				</div>
				<div className="space-y-1 text-xs mt-1">
					{generationTime !== null && generationTime !== undefined && (
						<div className="text-slate-600">
							<span className="text-slate-400">Generation:</span> {(generationTime / 1000).toFixed(2)}s
						</div>
					)}
					{tokensPerSecond && (
						<div className="text-purple-600 font-medium">
							{tokensPerSecond} tok/s
						</div>
					)}
				</div>
			</MetricTile>

			{/* Model & Provider Tile */}
			<MetricTile
				icon={<ModelIcon />}
				iconBg="bg-purple-100"
				iconColor="text-purple-600"
				title="Model"
			>
				<div className="font-mono text-sm font-medium text-slate-900 truncate" title={call.request.model}>
					{call.request.model.split('/').pop()}
				</div>
				{provider && (
					<div className="text-xs text-slate-500 mt-1">
						<span className="text-slate-400">via</span> {provider}
					</div>
				)}
				{call.response?.finishReason && (
					<div className="mt-2">
						<FinishReasonBadge reason={call.response.finishReason} />
					</div>
				)}
			</MetricTile>
		</div>
	)
}
