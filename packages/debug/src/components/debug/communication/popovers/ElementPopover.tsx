import type { DiagramLLMBlock, DiagramMessage, DiagramToolBlock, PopoverElement, TimeSegment } from '../types'

interface ElementPopoverProps {
	element: PopoverElement
	x: number
	y: number
}

export function ElementPopover({ element, x, y }: ElementPopoverProps) {
	// Offset from cursor
	const offsetX = 12
	const offsetY = 12

	return (
		<div
			className="fixed z-50 pointer-events-none"
			style={{
				left: x + offsetX,
				top: y + offsetY,
			}}
		>
			<div className="bg-slate-900 text-white text-[11px] rounded-md shadow-xl p-2.5 max-w-[280px] border border-slate-700">
				{element.type === 'message' && <MessagePopover data={element.data} />}
				{element.type === 'llm' && <LLMPopover data={element.data} />}
				{element.type === 'tool' && <ToolPopover data={element.data} />}
				{element.type === 'idle' && <IdlePopover data={element.data} />}
			</div>
		</div>
	)
}

function MessagePopover({ data }: { data: DiagramMessage }) {
	return (
		<div className="space-y-2">
			<div className="flex items-center gap-2">
				<span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
				<span className="font-medium text-blue-300">Message</span>
			</div>

			<div className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-[10px]">
				<span className="text-slate-500">From</span>
				<span className="text-slate-300 font-mono">{String(data.fromId).slice(0, 12)}</span>
				<span className="text-slate-500">To</span>
				<span className="text-slate-300 font-mono">{String(data.toId).slice(0, 12)}</span>
				<span className="text-slate-500">Time</span>
				<span className="text-slate-300">{new Date(data.timestamp).toLocaleTimeString()}</span>
			</div>

			<div className="pt-1.5 border-t border-slate-700/50">
				<div className="text-slate-300 leading-relaxed line-clamp-4">
					{data.content}
				</div>
			</div>
		</div>
	)
}

function LLMPopover({ data }: { data: DiagramLLMBlock }) {
	const duration = data.endTime
		? ((data.endTime - data.startTime) / 1000).toFixed(1) + 's'
		: null

	return (
		<div className="space-y-2">
			<div className="flex items-center gap-2">
				<span className="w-1.5 h-1.5 rounded-full bg-violet-400" />
				<span className="font-medium text-violet-300">LLM Inference</span>
				{data.status === 'running' && <span className="text-[9px] bg-amber-500/20 text-amber-300 px-1.5 py-0.5 rounded">Running</span>}
				{data.status === 'error' && <span className="text-[9px] bg-red-500/20 text-red-300 px-1.5 py-0.5 rounded">Error</span>}
			</div>

			<div className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-[10px]">
				{data.model && (
					<>
						<span className="text-slate-500">Model</span>
						<span className="text-slate-300 font-mono">{data.model.split('/').pop()}</span>
					</>
				)}
				{duration && (
					<>
						<span className="text-slate-500">Duration</span>
						<span className="text-slate-300">{duration}</span>
					</>
				)}
				{data.tokens && (
					<>
						<span className="text-slate-500">Tokens</span>
						<span className="text-slate-300">{data.tokens.toLocaleString()}</span>
					</>
				)}
			</div>

			{data.llmCallId && (
				<div className="pt-1.5 border-t border-slate-700/50 text-[9px] text-slate-500">
					Click to view details
				</div>
			)}
		</div>
	)
}

function ToolPopover({ data }: { data: DiagramToolBlock }) {
	const duration = data.endTime
		? ((data.endTime - data.startTime) / 1000).toFixed(1) + 's'
		: null

	return (
		<div className="space-y-2">
			<div className="flex items-center gap-2">
				<span className="w-1.5 h-1.5 rounded-full bg-teal-400" />
				<span className="font-medium text-teal-300">Tool Execution</span>
				{data.status === 'running' && <span className="text-[9px] bg-amber-500/20 text-amber-300 px-1.5 py-0.5 rounded">Running</span>}
				{data.status === 'error' && <span className="text-[9px] bg-red-500/20 text-red-300 px-1.5 py-0.5 rounded">Error</span>}
			</div>

			<div className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-[10px]">
				<span className="text-slate-500">Tool</span>
				<span className="text-slate-300 font-mono">{data.toolName}</span>
				{duration && (
					<>
						<span className="text-slate-500">Duration</span>
						<span className="text-slate-300">{duration}</span>
					</>
				)}
			</div>
		</div>
	)
}

function IdlePopover({ data }: { data: TimeSegment }) {
	const formatDuration = (ms: number): string => {
		const seconds = Math.floor(ms / 1000)
		const minutes = Math.floor(seconds / 60)
		const hours = Math.floor(minutes / 60)

		if (hours > 0) return `${hours}h ${minutes % 60}m`
		if (minutes > 0) return `${minutes}m ${seconds % 60}s`
		return `${seconds}s`
	}

	return (
		<div className="space-y-2">
			<div className="flex items-center gap-2">
				<span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
				<span className="font-medium text-slate-300">Idle Period</span>
			</div>

			<div className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-[10px]">
				<span className="text-slate-500">Duration</span>
				<span className="text-slate-300">{formatDuration(data.actualDuration)}</span>
				<span className="text-slate-500">From</span>
				<span className="text-slate-300">{new Date(data.startTime).toLocaleTimeString()}</span>
				<span className="text-slate-500">To</span>
				<span className="text-slate-300">{new Date(data.endTime).toLocaleTimeString()}</span>
			</div>
		</div>
	)
}
