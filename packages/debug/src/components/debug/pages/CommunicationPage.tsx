import { useAgentTree, useEvents, useEventStore } from '../../../stores/event-store'
import { CommunicationDiagram } from '../communication/CommunicationDiagram'
import { useDiagramData } from '../communication/hooks/useDiagramData'

export function CommunicationPage() {
	// Get events and agents from event store (already loaded by DebugLayout)
	const events = useEvents()
	const agents = useAgentTree()
	const isLoading = useEventStore((s) => s.isLoading)
	const error = useEventStore((s) => s.error)

	const diagramData = useDiagramData({ events, agents })

	// Calculate stats
	const messageCount = diagramData.messages.length
	const llmCount = diagramData.llmBlocks.length
	const toolCount = diagramData.toolBlocks.length
	const participantCount = diagramData.participants.length - 1 // Exclude user

	return (
		<div className="h-full flex flex-col gap-3">
			{/* Summary bar */}
			<div className="flex items-center gap-5 text-sm shrink-0">
				<div className="flex items-center gap-1.5">
					<span className="text-slate-400">Agents:</span>
					<span className="font-semibold text-slate-700">{participantCount}</span>
				</div>
				<div className="flex items-center gap-1.5">
					<span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
					<span className="text-slate-400">Messages:</span>
					<span className="font-semibold text-slate-700">{messageCount}</span>
				</div>
				<div className="flex items-center gap-1.5">
					<span className="w-1.5 h-1.5 rounded-full bg-violet-400" />
					<span className="text-slate-400">LLM:</span>
					<span className="font-semibold text-slate-700">{llmCount}</span>
				</div>
				<div className="flex items-center gap-1.5">
					<span className="w-1.5 h-1.5 rounded-full bg-teal-400" />
					<span className="text-slate-400">Tools:</span>
					<span className="font-semibold text-slate-700">{toolCount}</span>
				</div>
				{isLoading && events.length > 0 && <span className="text-slate-300 text-xs ml-auto">Updating...</span>}
			</div>

			{/* Error */}
			{error && (
				<div className="text-red-600 text-sm shrink-0 bg-red-50 border border-red-100 rounded-md px-3 py-2">
					{error}
				</div>
			)}

			{/* Loading state */}
			{isLoading && events.length === 0 && (
				<div className="flex-1 flex items-center justify-center">
					<div className="text-center">
						<div className="w-6 h-6 border-2 border-slate-200 border-t-violet-500 rounded-full animate-spin mx-auto mb-2" />
						<div className="text-sm text-slate-400">Loading diagram...</div>
					</div>
				</div>
			)}

			{/* Empty state */}
			{!isLoading && events.length === 0 && (
				<div className="flex-1 flex items-center justify-center">
					<div className="text-center">
						<svg className="w-10 h-10 text-slate-200 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth={1.5}
								d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
							/>
						</svg>
						<div className="text-sm text-slate-500 font-medium">No activity yet</div>
						<div className="text-xs text-slate-400 mt-0.5">Send a message to start</div>
					</div>
				</div>
			)}

			{/* Diagram */}
			{events.length > 0 && (
				<div className="flex-1 bg-white rounded-md border border-slate-200 overflow-hidden min-h-0">
					<CommunicationDiagram data={diagramData} />
				</div>
			)}
		</div>
	)
}
