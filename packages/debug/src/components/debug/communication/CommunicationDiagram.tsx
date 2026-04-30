import { useState } from 'react'
import { DiagramHeader } from './DiagramHeader.js'
import { IdleGap } from './elements/IdleGap.js'
import { LLMBlock } from './elements/LLMBlock.js'
import { MessageArrow } from './elements/MessageArrow.js'
import { ToolBlock } from './elements/ToolBlock.js'
import { useZoomPan } from './hooks/useZoomPan.js'
import { ParticipantLane } from './ParticipantLane.js'
import { ElementPopover } from './popovers/ElementPopover.js'
import { TimeAxis } from './TimeAxis.js'
import type { DiagramData, DiagramLLMBlock, DiagramMessage, DiagramToolBlock, PopoverState, TimeSegment } from './types.js'
import { LAYOUT } from './types.js'

interface CommunicationDiagramProps {
	data: DiagramData & {
		timestampToY: (timestamp: number) => number
		formatIdleDuration: (ms: number) => string
	}
}

export function CommunicationDiagram({ data }: CommunicationDiagramProps) {
	const [popover, setPopover] = useState<PopoverState>({ element: null, x: 0, y: 0 })
	const [showLabels, setShowLabels] = useState(false)

	const { state: zoomPan, containerRef, zoomIn, zoomOut, resetZoom, toggleAutoScroll, handleScroll, handleWheel } = useZoomPan(data.totalHeight)

	// Calculate dimensions
	const totalWidth = LAYOUT.timeAxisWidth + data.participants.length * (LAYOUT.participantWidth + LAYOUT.participantGap) + LAYOUT.padding
	const scaledHeight = data.totalHeight * zoomPan.zoom
	const scaledWidth = totalWidth * zoomPan.zoom

	// Calculate cumulative Y positions for idle gaps
	const idleGapPositions: Array<{ segment: TimeSegment; yPosition: number }> = []
	let cumulativeY = 0
	for (const segment of data.timeSegments) {
		if (segment.type === 'idle') {
			idleGapPositions.push({ segment, yPosition: cumulativeY })
		}
		cumulativeY += segment.displayHeight
	}

	const handleMessageHover = (message: DiagramMessage | null, x: number, y: number) => {
		if (message) {
			setPopover({ element: { type: 'message', data: message }, x, y })
		} else {
			setPopover({ element: null, x: 0, y: 0 })
		}
	}

	const handleLLMHover = (block: DiagramLLMBlock | null, x: number, y: number) => {
		if (block) {
			setPopover({ element: { type: 'llm', data: block }, x, y })
		} else {
			setPopover({ element: null, x: 0, y: 0 })
		}
	}

	const handleToolHover = (block: DiagramToolBlock | null, x: number, y: number) => {
		if (block) {
			setPopover({ element: { type: 'tool', data: block }, x, y })
		} else {
			setPopover({ element: null, x: 0, y: 0 })
		}
	}

	return (
		<div className="h-full flex flex-col">
			{/* Toolbar */}
			<div className="flex items-center gap-3 px-3 py-2 bg-slate-50/80 border-b border-slate-100 shrink-0">
				{/* Zoom controls */}
				<div className="flex items-center gap-1 bg-white rounded-md border border-slate-200 p-0.5">
					<button
						onClick={zoomOut}
						className="w-7 h-7 flex items-center justify-center text-slate-500 hover:bg-slate-100 rounded-md transition-colors"
						title="Zoom Out (Ctrl+-)"
					>
						<MinusIcon />
					</button>
					<span className="text-xs text-slate-600 w-12 text-center font-medium">
						{Math.round(zoomPan.zoom * 100)}%
					</span>
					<button
						onClick={zoomIn}
						className="w-7 h-7 flex items-center justify-center text-slate-500 hover:bg-slate-100 rounded-md transition-colors"
						title="Zoom In (Ctrl++)"
					>
						<PlusIcon />
					</button>
				</div>

				<button
					onClick={resetZoom}
					className="px-2 py-1 text-xs text-slate-500 hover:text-slate-700 hover:bg-white rounded border border-transparent hover:border-slate-200 transition-colors"
				>
					Reset
				</button>

				<div className="h-4 w-px bg-slate-200" />

				<button
					onClick={toggleAutoScroll}
					className={`flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md transition-colors ${
						zoomPan.autoScroll
							? 'bg-violet-50 text-violet-600 border border-violet-200'
							: 'bg-white text-slate-500 border border-slate-200 hover:border-slate-300'
					}`}
				>
					<AutoScrollIcon active={zoomPan.autoScroll} />
					Auto-scroll
				</button>

				<div className="h-4 w-px bg-slate-200" />

				{/* Show labels toggle */}
				<label className="flex items-center gap-2 cursor-pointer select-none">
					<input
						type="checkbox"
						checked={showLabels}
						onChange={(e) => setShowLabels(e.target.checked)}
						className="w-3.5 h-3.5 rounded border-slate-300 text-violet-500 focus:ring-violet-500 focus:ring-offset-0"
					/>
					<span className="text-xs text-slate-600">Show message text</span>
				</label>

				<div className="flex-1" />

				{/* Legend */}
				<div className="flex items-center gap-4 text-[10px] text-slate-400">
					<span className="flex items-center gap-1.5">
						<span className="w-4 h-px bg-blue-300" />
						Messages
					</span>
					<span className="flex items-center gap-1.5">
						<span className="w-3 h-3 bg-violet-50 border border-violet-200 rounded" />
						LLM
					</span>
					<span className="flex items-center gap-1.5">
						<span className="w-3 h-3 bg-teal-50 border border-teal-200 rounded" />
						Tools
					</span>
				</div>
			</div>

			{/* Diagram container */}
			<div className="flex-1 flex flex-col min-h-0 overflow-hidden">
				{/* Header (sticky) - scales with zoom */}
				<DiagramHeader participants={data.participants} zoom={zoomPan.zoom} />

				{/* Scrollable SVG area */}
				<div
					ref={containerRef}
					className="flex-1 overflow-auto bg-white"
					onScroll={handleScroll}
					onWheel={handleWheel}
				>
					<svg
						width={scaledWidth}
						height={scaledHeight + LAYOUT.padding * 2}
					>
						<g transform={`scale(${zoomPan.zoom})`}>
							<g transform={`translate(0, ${LAYOUT.padding})`}>
								{/* Background grid lines for participant lanes */}
								{data.participants.map((participant) => (
									<ParticipantLane
										key={participant.id}
										participant={participant}
										totalHeight={data.totalHeight}
									/>
								))}

								{/* Time axis */}
								<TimeAxis
									segments={data.timeSegments}
									sessionStartTime={data.sessionStartTime}
									timestampToY={data.timestampToY}
									totalHeight={data.totalHeight}
								/>

								{/* Idle gaps */}
								{idleGapPositions.map((item, idx) => (
									<IdleGap
										key={idx}
										segment={item.segment}
										participants={data.participants}
										yPosition={item.yPosition}
										formatDuration={data.formatIdleDuration}
									/>
								))}

								{/* LLM blocks */}
								{data.llmBlocks.map((block) => (
									<LLMBlock
										key={block.id}
										block={block}
										participants={data.participants}
										onHover={handleLLMHover}
									/>
								))}

								{/* Tool blocks */}
								{data.toolBlocks.map((block) => (
									<ToolBlock
										key={block.id}
										block={block}
										participants={data.participants}
										onHover={handleToolHover}
									/>
								))}

								{/* Messages (on top) */}
								{data.messages.map((message) => (
									<MessageArrow
										key={message.id}
										message={message}
										participants={data.participants}
										showLabel={showLabels}
										onHover={handleMessageHover}
									/>
								))}
							</g>
						</g>
					</svg>
				</div>
			</div>

			{/* Popover */}
			{popover.element && (
				<ElementPopover
					element={popover.element}
					x={popover.x}
					y={popover.y}
				/>
			)}
		</div>
	)
}

function MinusIcon() {
	return (
		<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
		</svg>
	)
}

function PlusIcon() {
	return (
		<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
		</svg>
	)
}

function AutoScrollIcon({ active }: { active: boolean }) {
	return (
		<svg className={`w-3.5 h-3.5 ${active ? 'text-violet-500' : 'text-slate-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
		</svg>
	)
}
