import type { DebugChatMessage } from '@roj-ai/shared'
import { useState } from 'react'
import { DebugLink } from '../DebugNavigation.js'
import { useChatDebug, useEventStore } from '../../../stores/event-store.js'

export function UserChatPage() {

	// Get chat debug messages from event store
	const messages = useChatDebug()
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
	const userCount = messages.filter((m) => m.type === 'user_message').length
	const agentCount = messages.filter((m) => m.type === 'agent_message').length
	const askUserCount = messages.filter((m) => m.type === 'ask_user').length
	const answeredCount = messages.filter((m) => m.type === 'ask_user' && m.answered).length

	return (
		<div className="space-y-4">
			{/* Summary */}
			<div className="flex items-center gap-6 text-sm">
				<span className="text-slate-600">
					<span className="font-medium text-slate-900">{total}</span> messages
				</span>
				<span className="text-slate-600">
					<span className="font-medium text-blue-600">{userCount}</span> user
				</span>
				<span className="text-slate-600">
					<span className="font-medium text-green-600">{agentCount}</span> agent
				</span>
				{askUserCount > 0 && (
					<span className="text-slate-600">
						<span className="font-medium text-purple-600">{askUserCount}</span> questions
						{answeredCount > 0 && <span className="text-slate-500">({answeredCount} answered)</span>}
					</span>
				)}
			</div>

			{/* Error */}
			{error && <div className="text-red-500 text-sm">{error}</div>}

			{/* Loading */}
			{isLoading && messages.length === 0 && <div className="text-slate-500 text-sm">Loading chat messages...</div>}

			{/* Table */}
			{messages.length > 0 && (
				<div className="bg-white rounded-md border border-slate-200 overflow-hidden">
					<div className="overflow-x-auto">
						<table className="w-full text-sm">
							<thead className="bg-slate-50 border-b border-slate-200">
								<tr>
									<th className="px-3 py-2 text-left font-medium text-slate-600 w-20">Type</th>
									<th className="px-3 py-2 text-left font-medium text-slate-600">Content</th>
									<th className="px-3 py-2 text-left font-medium text-slate-600 w-24">Agent</th>
									<th className="px-3 py-2 text-left font-medium text-slate-600 w-32">Links</th>
									<th className="px-3 py-2 text-left font-medium text-slate-600 w-20">Time</th>
									<th className="px-3 py-2 text-left font-medium text-slate-600 w-16">Event</th>
								</tr>
							</thead>
							<tbody className="divide-y divide-slate-200">
								{messages.map((msg) => (
									<MessageRow
										key={msg.messageId}
										message={msg}
										isExpanded={expandedIds.has(msg.messageId)}
										onToggleExpand={() => toggleExpanded(msg.messageId)}
									/>
								))}
							</tbody>
						</table>
					</div>
				</div>
			)}

			{/* Empty state */}
			{!isLoading && messages.length === 0 && <div className="text-slate-500 text-sm">No chat messages found</div>}
		</div>
	)
}

function MessageRow({
	message,
	isExpanded,
	onToggleExpand,
}: {
	message: DebugChatMessage
	isExpanded: boolean
	onToggleExpand: () => void
}) {
	const isLongMessage = message.content.length > 100
	const displayContent = isExpanded
		? message.content
		: message.content.slice(0, 100) + (isLongMessage ? '...' : '')

	return (
		<tr className="hover:bg-slate-50">
			{/* Type */}
			<td className="px-3 py-2">
				<TypeBadge type={message.type} answered={message.answered} />
			</td>

			{/* Content */}
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
				{/* Show answer for ask_user messages */}
				{message.type === 'ask_user' && message.answered && (
					<div className="mt-1 text-xs text-slate-500">
						Answer: <span className="font-mono">{JSON.stringify(message.answer)}</span>
					</div>
				)}
				{/* Show input type for ask_user messages */}
				{message.type === 'ask_user' && message.inputType && (
					<div className="mt-1 text-xs text-slate-400">
						Input: {message.inputType.type}
					</div>
				)}
			</td>

			{/* Agent */}
			<td className="px-3 py-2">
				{message.agentId && message.agentName && (
					<AgentBadge
						agentId={message.agentId}
						agentName={message.agentName}
					/>
				)}
			</td>

			{/* Links */}
			<td className="px-3 py-2">
				<div className="flex flex-wrap gap-1">
					{message.llmCallId && (
						<DebugLink
							to={`llm-calls/${message.llmCallId}`}
							className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-yellow-100 text-yellow-700 hover:bg-yellow-200"
						>
							LLM
						</DebugLink>
					)}
					{message.toolCallId && (
						<span
							className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-slate-100 text-slate-600"
							title={`Tool Call: ${message.toolCallId}`}
						>
							Tool
						</span>
					)}
					{message.mailboxMessageId && (
						<DebugLink
							to="mailbox"
							className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-indigo-100 text-indigo-700 hover:bg-indigo-200"
						>
							Mailbox
						</DebugLink>
					)}
				</div>
			</td>

			{/* Time */}
			<td className="px-3 py-2 font-mono text-xs text-slate-500 whitespace-nowrap">
				{new Date(message.timestamp).toLocaleTimeString()}
			</td>

			{/* Event Index */}
			<td className="px-3 py-2 font-mono text-xs text-slate-400">
				#{message.eventIndex}
			</td>
		</tr>
	)
}

function TypeBadge({ type, answered }: { type: DebugChatMessage['type']; answered?: boolean }) {
	switch (type) {
		case 'user_message':
			return (
				<span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-700">
					User
				</span>
			)
		case 'agent_message':
			return (
				<span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-700">
					Agent
				</span>
			)
		case 'ask_user':
			return (
				<span
					className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
						answered
							? 'bg-purple-100 text-purple-700'
							: 'bg-purple-200 text-purple-800 animate-pulse'
					}`}
				>
					Question{answered ? '' : ' (pending)'}
				</span>
			)
	}
}

function AgentBadge({
	agentId,
	agentName,
}: {
	agentId: string
	agentName: string
}) {
	return (
		<DebugLink
			to={`agents/${agentId}`}
			className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-700 hover:bg-slate-200"
		>
			<span className="truncate max-w-20" title={agentName}>
				{agentName}
			</span>
		</DebugLink>
	)
}
