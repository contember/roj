import type { BuiltinEvent, DomainEvent, InferenceCompletedEvent, InferenceFailedEvent } from '@roj-ai/sdk'
import { useCallback, useMemo, useState } from 'react'
import { DebugLink, useDebugSessionId } from '../DebugNavigation'
import { api, unwrap } from '@roj-ai/client'
import { useEvents, useEventStore } from '../../../stores/event-store'

const EVENT_TYPES = [
	'all',
	'session_created',
	'session_closed',
	'agent_spawned',
	'agent_state_changed',
	'mailbox_message',
	'mailbox_consumed',
	'inference_started',
	'inference_completed',
	'inference_failed',
	'tool_started',
	'tool_completed',
	'tool_failed',
	'context_compacted',
	'user_question_asked',
	'user_message_sent',
	'communicator_linked',
	'session_restarted',
] as const

const PAGE_SIZE = 50

export function EventsPage() {
	const sessionId = useDebugSessionId()

	// Get events from event store (already loaded by DebugLayout)
	const allEvents = useEvents()
	const isLoading = useEventStore((s) => s.isLoading)
	const error = useEventStore((s) => s.error)

	const [typeFilter, setTypeFilter] = useState<string>('all')
	const [offset, setOffset] = useState(0)

	// Wrap events with original index for fork API
	const indexedEvents = useMemo(() => allEvents.map((event, originalIndex) => ({ event, originalIndex })), [allEvents])

	// Filter events locally
	const filteredEvents = useMemo(() => {
		if (typeFilter === 'all') return indexedEvents
		return indexedEvents.filter((e) => e.event.type === typeFilter)
	}, [indexedEvents, typeFilter])

	// Apply pagination
	const paginatedEvents = useMemo(() => {
		return filteredEvents.slice(offset, offset + PAGE_SIZE)
	}, [filteredEvents, offset])

	const handleFork = useCallback(async (eventIndex: number) => {
		if (!sessionId) return
		const result = unwrap(await api.call('sessions.fork', { sessionId, eventIndex }))
		const newUrl = window.location.pathname.replace(sessionId, result.sessionId)
		window.open(newUrl, '_blank')
	}, [sessionId])

	const total = filteredEvents.length
	const totalPages = Math.ceil(total / PAGE_SIZE)
	const currentPage = Math.floor(offset / PAGE_SIZE) + 1

	return (
		<div className="space-y-4">
			{/* Filter */}
			<div className="flex items-center gap-4">
				<label className="text-sm text-slate-600">
					Filter by type:
					<select
						value={typeFilter}
						onChange={(e) => {
							setTypeFilter(e.target.value)
							setOffset(0) // Reset pagination when filter changes
						}}
						className="ml-2 border border-slate-300 rounded px-2 py-1 text-sm"
					>
						{EVENT_TYPES.map((type) => (
							<option key={type} value={type}>
								{type === 'all' ? 'All Events' : type}
							</option>
						))}
					</select>
				</label>
				<span className="text-sm text-slate-500">{total} events total</span>
			</div>

			{/* Error */}
			{error && <div className="text-red-500 text-sm">{error}</div>}

			{/* Events List */}
			<div className="bg-white rounded-md border border-slate-200 overflow-hidden">
				{isLoading && allEvents.length === 0
					? <div className="p-4 text-slate-500 text-sm">Loading...</div>
					: paginatedEvents.length === 0
					? <div className="p-4 text-slate-500 text-sm">No events found</div>
					: (
						<div className="divide-y divide-slate-200">
							{paginatedEvents.map(({ event, originalIndex }) => (
								<EventRow
									key={`${event.timestamp}-${originalIndex}`}
									event={event}
									eventIndex={originalIndex}
									onFork={handleFork}
								/>
							))}
						</div>
					)}
			</div>

			{/* Pagination */}
			{totalPages > 1 && (
				<div className="flex items-center justify-between">
					<button
						onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
						disabled={offset === 0}
						className="px-3 py-1 text-sm border border-slate-300 rounded hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
					>
						Previous
					</button>
					<span className="text-sm text-slate-600">
						Page {currentPage} of {totalPages}
					</span>
					<button
						onClick={() => setOffset(offset + PAGE_SIZE)}
						disabled={currentPage >= totalPages}
						className="px-3 py-1 text-sm border border-slate-300 rounded hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
					>
						Next
					</button>
				</div>
			)}
		</div>
	)
}

function EventRow({
	event,
	eventIndex,
	onFork,
}: {
	event: DomainEvent
	eventIndex: number
	onFork: (eventIndex: number) => Promise<void>
}) {
	const [expanded, setExpanded] = useState(false)
	const [forking, setForking] = useState(false)

	const typeColors: Record<string, string> = {
		session_created: 'bg-green-100 text-green-700',
		session_closed: 'bg-slate-100 text-slate-700',
		agent_spawned: 'bg-blue-100 text-blue-700',
		agent_state_changed: 'bg-yellow-100 text-yellow-700',
		mailbox_message: 'bg-purple-100 text-purple-700',
		mailbox_consumed: 'bg-purple-50 text-purple-600',
		inference_started: 'bg-orange-100 text-orange-700',
		inference_completed: 'bg-green-100 text-green-700',
		inference_failed: 'bg-red-100 text-red-700',
		tool_started: 'bg-cyan-100 text-cyan-700',
		tool_completed: 'bg-green-100 text-green-700',
		tool_failed: 'bg-red-100 text-red-700',
		context_compacted: 'bg-slate-100 text-slate-700',
		user_question_asked: 'bg-yellow-100 text-yellow-700',
		user_message_sent: 'bg-blue-100 text-blue-700',
	}

	const llmCallId = (event.type === 'inference_completed' || event.type === 'inference_failed')
		&& (event as InferenceCompletedEvent | InferenceFailedEvent).llmCallId

	const agentId = 'agentId' in event ? (event as { agentId: string }).agentId : null

	return (
		<div className="text-sm">
			<button
				onClick={() => setExpanded(!expanded)}
				className="w-full p-3 hover:bg-slate-50 flex items-center gap-3 text-left"
			>
				<span className="text-xs text-slate-400 font-mono w-20 shrink-0">
					{new Date(event.timestamp).toLocaleTimeString()}
				</span>
				<span
					className={`text-xs px-2 py-0.5 rounded-full font-medium shrink-0 ${typeColors[event.type] || 'bg-slate-100'}`}
				>
					{event.type}
				</span>
				<span className="text-slate-600 truncate flex-1">
					{getEventSummary(event)}
				</span>

				{/* Links */}
				<div className="flex items-center gap-2 shrink-0">
					{agentId && (
						<DebugLink
							to={`agents/${agentId}`}
							className="text-xs text-violet-600 hover:underline"
						>
							Agent
						</DebugLink>
					)}
					{llmCallId && (
						<DebugLink
							to={`llm-calls/${llmCallId}`}
							className="text-xs text-violet-600 hover:underline"
						>
							LLM Call
						</DebugLink>
					)}
					<button
						onClick={async (e) => {
							e.stopPropagation()
							setForking(true)
							try {
								await onFork(eventIndex)
							} finally {
								setForking(false)
							}
						}}
						disabled={forking}
						className="text-xs text-violet-600 hover:underline disabled:opacity-50"
					>
						{forking ? 'Forking...' : 'Fork'}
					</button>
				</div>

				<span className="text-slate-400 shrink-0">{expanded ? '▼' : '▶'}</span>
			</button>
			{expanded && (
				<div className="px-3 pb-3 bg-slate-50">
					<pre className="text-xs overflow-x-auto p-3 bg-white border border-slate-200 rounded-md">
            {JSON.stringify(event, null, 2)}
					</pre>
				</div>
			)}
		</div>
	)
}

function getEventSummary(event: DomainEvent): string {
	const e = event as BuiltinEvent
	switch (e.type) {
		case 'session_created':
			return `Preset: ${e.presetId}`
		case 'session_closed':
			return 'Session closed'
		case 'agent_spawned':
			return `${e.definitionName} (${e.agentId.slice(0, 8)})`
		case 'agent_state_changed':
			return `${e.fromState} → ${e.toState}`
		case 'mailbox_message':
			return `To: ${e.toAgentId.slice(0, 8)}`
		case 'mailbox_consumed':
			return `${e.messageIds.length} messages`
		case 'inference_started':
			return `Agent: ${e.agentId.slice(0, 8)}`
		case 'inference_completed':
			return `${e.metrics.totalTokens} tokens, ${e.metrics.model}`
		case 'inference_failed':
			return e.error
		case 'tool_started':
			return `${e.toolName}`
		case 'tool_completed':
			return `${e.toolCallId.slice(0, 8)} completed`
		case 'tool_failed':
			return `${e.toolCallId.slice(0, 8)}: ${e.error}`
		case 'context_compacted':
			return `${e.originalTokens} → ${e.compactedTokens} tokens`
		case 'user_question_asked':
			return e.question.slice(0, 50) + (e.question.length > 50 ? '...' : '')
		case 'user_message_sent':
			return e.message.slice(0, 50) + (e.message.length > 50 ? '...' : '')
		default:
			return ''
	}
}
