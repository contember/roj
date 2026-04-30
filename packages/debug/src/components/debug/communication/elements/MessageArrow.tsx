import type { DiagramMessage, DiagramParticipant } from '../types.js'
import { LAYOUT } from '../types.js'

interface MessageArrowProps {
	message: DiagramMessage
	participants: DiagramParticipant[]
	showLabel?: boolean
	onHover?: (message: DiagramMessage | null, x: number, y: number) => void
	onClick?: (message: DiagramMessage) => void
}

export function MessageArrow({ message, participants, showLabel = false, onHover, onClick }: MessageArrowProps) {
	const fromParticipant = participants.find((p) => p.id === message.fromId)
	const toParticipant = participants.find((p) => p.id === message.toId)

	if (!fromParticipant || !toParticipant) {
		return null
	}

	const fromX = LAYOUT.timeAxisWidth + fromParticipant.columnIndex * (LAYOUT.participantWidth + LAYOUT.participantGap) + LAYOUT.participantWidth / 2
	const toX = LAYOUT.timeAxisWidth + toParticipant.columnIndex * (LAYOUT.participantWidth + LAYOUT.participantGap) + LAYOUT.participantWidth / 2

	const y = message.yPosition
	const isLeftToRight = fromX < toX

	// Arrow head size
	const arrowSize = 6
	const arrowDirection = isLeftToRight ? 1 : -1

	// Calculate label position
	const midX = (fromX + toX) / 2
	const labelMaxWidth = Math.abs(toX - fromX) - 20

	// Truncate content for label
	const truncatedContent = message.content.length > 50
		? message.content.slice(0, 50) + '…'
		: message.content

	return (
		<g
			className="cursor-pointer group"
			onMouseEnter={(e) => onHover?.(message, e.clientX, e.clientY)}
			onMouseLeave={() => onHover?.(null, 0, 0)}
			onClick={() => onClick?.(message)}
		>
			{/* Invisible wider hit area for easier hovering */}
			<line
				x1={fromX}
				y1={y}
				x2={toX}
				y2={y}
				stroke="transparent"
				strokeWidth={16}
			/>

			{/* Arrow line */}
			<line
				x1={fromX}
				y1={y}
				x2={toX - arrowDirection * arrowSize}
				y2={y}
				className="stroke-blue-300 group-hover:stroke-blue-500 transition-colors"
				strokeWidth={1.5}
			/>

			{/* Arrow head */}
			<polygon
				points={`
          ${toX},${y}
          ${toX - arrowDirection * arrowSize},${y - arrowSize / 2}
          ${toX - arrowDirection * arrowSize},${y + arrowSize / 2}
        `}
				className="fill-blue-300 group-hover:fill-blue-500 transition-colors"
			/>

			{/* Small dot at start */}
			<circle
				cx={fromX}
				cy={y}
				r={2.5}
				className="fill-blue-300 group-hover:fill-blue-500 transition-colors"
			/>

			{/* Label (optional) */}
			{showLabel && labelMaxWidth > 40 && (
				<g>
					{/* Label background */}
					<rect
						x={midX - labelMaxWidth / 2}
						y={y - 18}
						width={labelMaxWidth}
						height={14}
						rx={3}
						className="fill-white/90 stroke-blue-200 group-hover:stroke-blue-300"
						strokeWidth={0.5}
					/>
					{/* Label text */}
					<text
						x={midX}
						y={y - 9}
						textAnchor="middle"
						dominantBaseline="middle"
						className="text-[9px] fill-slate-600 group-hover:fill-slate-800"
						style={{
							fontSize: '9px',
							clipPath: `inset(0 0 0 0)`,
						}}
					>
						<tspan>
							{truncatedContent.length > labelMaxWidth / 5
								? truncatedContent.slice(0, Math.floor(labelMaxWidth / 5)) + '…'
								: truncatedContent}
						</tspan>
					</text>
				</g>
			)}
		</g>
	)
}
