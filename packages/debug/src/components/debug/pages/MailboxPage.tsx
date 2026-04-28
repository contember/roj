import type { GlobalMailboxMessage } from '@roj-ai/shared'
import { useState } from 'react'
import { useEventStore, useGlobalMailbox } from '../../../stores/event-store'
import { DebugLink } from '../DebugNavigation'

export function MailboxPage() {
	// Get mailbox from event store (already loaded by DebugLayout)
	const messages = useGlobalMailbox()
	const isLoading = useEventStore((s) => s.isLoading)
	const error = useEventStore((s) => s.error)

	const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())

	const toggleExpanded = (id: string) => {
		setExpandedIds((prev) => {
			const next = new Set(prev)
			if (next.has(id)) {
				next.delete(id)
			} else {
				next.add(id)
			}
			return next
		})
	}

	// Calculate stats
	const total = messages.length
	const pendingCount = messages.filter((m) => !m.consumed).length
	const consumedCount = messages.filter((m) => m.consumed).length

	return (
		<div className="space-y-4">
			{/* Summary */}
			<div className="flex items-center gap-6 text-sm">
				<span className="text-slate-600">
					<span className="font-medium text-slate-900">{total}</span> messages
				</span>
				<span className="text-slate-600">
					<span className="font-medium text-green-600">{consumedCount}</span> read
				</span>
				{pendingCount > 0 && (
					<span className="text-slate-600">
						<span className="font-medium text-blue-600">{pendingCount}</span> pending
					</span>
				)}
			</div>

			{/* Error */}
			{error && <div className="text-red-500 text-sm">{error}</div>}

			{/* Loading */}
			{isLoading && messages.length === 0 && <div className="text-slate-500 text-sm">Loading mailbox...</div>}

			{/* Table */}
			{messages.length > 0 && (
				<div className="bg-white rounded-md border border-slate-200 overflow-hidden">
					<div className="overflow-x-auto">
						<table className="w-full text-sm">
							<thead className="bg-slate-50 border-b border-slate-200">
								<tr>
									<th className="px-3 py-2 text-left font-medium text-slate-600">From</th>
									<th className="px-3 py-2 text-center font-medium text-slate-600 w-8"></th>
									<th className="px-3 py-2 text-left font-medium text-slate-600">To</th>
									<th className="px-3 py-2 text-left font-medium text-slate-600">Message</th>
									<th className="px-3 py-2 text-left font-medium text-slate-600">Time</th>
									<th className="px-3 py-2 text-center font-medium text-slate-600">Status</th>
								</tr>
							</thead>
							<tbody className="divide-y divide-slate-200">
								{messages.map((msg) => (
									<MessageRow
										key={msg.id}
										message={msg}
										isExpanded={expandedIds.has(msg.id)}
										onToggleExpand={() => toggleExpanded(msg.id)}
									/>
								))}
							</tbody>
						</table>
					</div>
				</div>
			)}

			{/* Empty state */}
			{!isLoading && messages.length === 0 && <div className="text-slate-500 text-sm">No messages found</div>}
		</div>
	)
}

function MessageRow({
	message,
	isExpanded,
	onToggleExpand,
}: {
	message: GlobalMailboxMessage
	isExpanded: boolean
	onToggleExpand: () => void
}) {
	const isLongMessage = message.content.length > 100
	const displayContent = isExpanded
		? message.content
		: message.content.slice(0, 100) + (isLongMessage ? '...' : '')

	return (
		<tr className="hover:bg-slate-50">
			{/* From */}
			<td className="px-3 py-2">
				<AgentBadge
					agentId={message.fromAgentId}
					agentName={message.fromAgentName}
	
				/>
			</td>

			{/* Arrow */}
			<td className="px-3 py-2 text-center text-slate-400">
				<ArrowIcon />
			</td>

			{/* To */}
			<td className="px-3 py-2">
				<AgentBadge
					agentId={message.toAgentId}
					agentName={message.toAgentName}
	
				/>
			</td>

			{/* Message */}
			<td className="px-3 py-2">
				<div
					className={`text-slate-700 ${isLongMessage ? 'cursor-pointer' : ''}`}
					onClick={isLongMessage ? onToggleExpand : undefined}
				>
					<span className="whitespace-pre-wrap break-words">{displayContent}</span>
					{isLongMessage && (
						<button
							onClick={(e) => {
								e.stopPropagation()
								onToggleExpand()
							}}
							className="ml-2 text-violet-600 hover:text-violet-800 text-xs"
						>
							{isExpanded ? 'less' : 'more'}
						</button>
					)}
				</div>
			</td>

			{/* Time */}
			<td className="px-3 py-2 font-mono text-xs text-slate-500 whitespace-nowrap">
				{new Date(message.timestamp).toLocaleTimeString()}
			</td>

			{/* Status */}
			<td className="px-3 py-2 text-center">
				<StatusBadge consumed={message.consumed} />
			</td>
		</tr>
	)
}

function AgentBadge({
	agentId,
	agentName,
}: {
	agentId: string
	agentName: string
}) {
	const isSpecial = agentId === 'user' || agentId === 'orchestrator' || agentId === 'communicator'

	if (isSpecial) {
		return (
			<span
				className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${
					agentId === 'user'
						? 'bg-blue-100 text-blue-700'
						: 'bg-purple-100 text-purple-700'
				}`}
			>
				<span className="truncate max-w-24" title={agentName}>
					{agentName}
				</span>
			</span>
		)
	}

	return (
		<DebugLink
			to={`agents/${agentId}`}
			className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-700 hover:bg-slate-200"
		>
			<span className="truncate max-w-24" title={agentName}>
				{agentName}
			</span>
		</DebugLink>
	)
}

function StatusBadge({ consumed }: { consumed: boolean }) {
	if (consumed) {
		return (
			<span className="inline-flex items-center gap-1 text-xs text-slate-500">
				<CheckIcon />
				<span>Read</span>
			</span>
		)
	}

	return (
		<span className="inline-flex items-center gap-1 text-xs text-blue-600">
			<span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
			<span>Pending</span>
		</span>
	)
}

function ArrowIcon() {
	return (
		<svg className="w-4 h-4 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
		</svg>
	)
}

function CheckIcon() {
	return (
		<svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
		</svg>
	)
}
