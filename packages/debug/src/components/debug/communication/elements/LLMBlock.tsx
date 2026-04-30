import { useDebugNavigate } from '../../DebugNavigation.js'
import type { DiagramLLMBlock, DiagramParticipant } from '../types.js'
import { COLORS, LAYOUT } from '../types.js'

interface LLMBlockProps {
	block: DiagramLLMBlock
	participants: DiagramParticipant[]
	onHover?: (block: DiagramLLMBlock | null, x: number, y: number) => void
	onClick?: (block: DiagramLLMBlock) => void
}

export function LLMBlock({ block, participants, onHover, onClick }: LLMBlockProps) {
	const navigate = useDebugNavigate()
	const participant = participants.find((p) => p.id === block.participantId)

	if (!participant) {
		return null
	}

	const laneX = LAYOUT.timeAxisWidth + participant.columnIndex * (LAYOUT.participantWidth + LAYOUT.participantGap) + LAYOUT.participantWidth / 2
	const x = laneX - LAYOUT.blockWidth / 2
	const y = block.yStart
	const height = Math.max(LAYOUT.blockMinHeight, block.yEnd - block.yStart)

	const isRunning = block.status === 'running'
	const isError = block.status === 'error'

	const content = (
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
          ${isError ? COLORS.error.fill : isRunning ? COLORS.llm.fillRunning : COLORS.llm.fill}
          ${isError ? COLORS.error.stroke : COLORS.llm.stroke}
          stroke-1
          group-hover:stroke-violet-400
          transition-colors
          ${isRunning ? 'animate-pulse' : ''}
        `}
			/>

			{/* Icon */}
			<g transform={`translate(${x + 6}, ${y + height / 2 - 5})`}>
				<svg width="10" height="10" viewBox="0 0 24 24" fill="none" className={isError ? COLORS.error.text : COLORS.llm.text}>
					<path
						d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			</g>

			{/* Label */}
			<text
				x={x + 20}
				y={y + height / 2}
				dominantBaseline="middle"
				className={`text-[10px] font-medium ${isError ? COLORS.error.text : COLORS.llm.text} fill-current`}
			>
				LLM
			</text>

			{/* Status indicators */}
			{isRunning && (
				<circle
					cx={x + LAYOUT.blockWidth - 8}
					cy={y + 8}
					r={3}
					className="fill-violet-500 animate-pulse"
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

	// Wrap in clickable group if we have an LLM call ID
	if (block.llmCallId) {
		return (
			<g style={{ cursor: 'pointer' }} onClick={() => navigate(`llm-calls/${block.llmCallId}`)}>
				{content}
			</g>
		)
	}

	return content
}
