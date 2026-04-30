import type { DiagramParticipant, DiagramToolBlock } from '../types.js'
import { COLORS, LAYOUT } from '../types.js'

interface ToolBlockProps {
	block: DiagramToolBlock
	participants: DiagramParticipant[]
	onHover?: (block: DiagramToolBlock | null, x: number, y: number) => void
	onClick?: (block: DiagramToolBlock) => void
}

export function ToolBlock({ block, participants, onHover, onClick }: ToolBlockProps) {
	const participant = participants.find((p) => p.id === block.participantId)

	if (!participant) {
		return null
	}

	const laneX = LAYOUT.timeAxisWidth + participant.columnIndex * (LAYOUT.participantWidth + LAYOUT.participantGap) + LAYOUT.participantWidth / 2
	const x = laneX - LAYOUT.blockWidth / 2
	const y = block.yStart
	const height = Math.max(LAYOUT.blockMinHeight - 4, block.yEnd - block.yStart)

	const isRunning = block.status === 'running'
	const isError = block.status === 'error'

	// Truncate tool name
	const toolName = block.toolName.length > 8
		? block.toolName.slice(0, 8) + '…'
		: block.toolName

	return (
		<g
			className="cursor-pointer group"
			onMouseEnter={(e) => onHover?.(block, e.clientX, e.clientY)}
			onMouseLeave={() => onHover?.(null, 0, 0)}
			onClick={() => onClick?.(block)}
		>
			{/* Block rectangle */}
			<rect
				x={x}
				y={y}
				width={LAYOUT.blockWidth}
				height={height}
				rx={4}
				ry={4}
				className={`
          ${isError ? COLORS.error.fill : isRunning ? COLORS.tool.fillRunning : COLORS.tool.fill}
          ${isError ? COLORS.error.stroke : COLORS.tool.stroke}
          stroke-1
          group-hover:stroke-teal-400
          transition-colors
          ${isRunning ? 'animate-pulse' : ''}
        `}
			/>

			{/* Tool icon */}
			<g transform={`translate(${x + 6}, ${y + height / 2 - 5})`}>
				<svg width="10" height="10" viewBox="0 0 24 24" fill="none" className={isError ? COLORS.error.text : COLORS.tool.text}>
					<path
						d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			</g>

			{/* Tool name */}
			<text
				x={x + 20}
				y={y + height / 2}
				dominantBaseline="middle"
				className={`text-[9px] font-mono ${isError ? COLORS.error.text : COLORS.tool.text} fill-current`}
			>
				{toolName}
			</text>

			{/* Status indicators */}
			{isRunning && (
				<circle
					cx={x + LAYOUT.blockWidth - 8}
					cy={y + 8}
					r={3}
					className="fill-teal-500 animate-pulse"
				/>
			)}

			{isError && (
				<circle
					cx={x + LAYOUT.blockWidth - 8}
					cy={y + 8}
					r={3}
					className="fill-red-500"
				/>
			)}
		</g>
	)
}
