import type { DiagramParticipant } from './types.js'
import { LAYOUT } from './types.js'

interface ParticipantLaneProps {
	participant: DiagramParticipant
	totalHeight: number
}

export function ParticipantLane({ participant, totalHeight }: ParticipantLaneProps) {
	const x = LAYOUT.timeAxisWidth + participant.columnIndex * (LAYOUT.participantWidth + LAYOUT.participantGap)
	const centerX = x + LAYOUT.participantWidth / 2
	const isOdd = participant.columnIndex % 2 === 1
	const columnWidth = LAYOUT.participantWidth + LAYOUT.participantGap

	return (
		<g>
			{/* Column background - alternating */}
			<rect
				x={x - LAYOUT.participantGap / 2}
				y={0}
				width={columnWidth}
				height={totalHeight}
				className={isOdd ? 'fill-slate-50/80' : 'fill-white'}
			/>

			{/* Column border - left side */}
			<line
				x1={x - LAYOUT.participantGap / 2}
				y1={0}
				x2={x - LAYOUT.participantGap / 2}
				y2={totalHeight}
				className="stroke-slate-200"
				strokeWidth={1}
			/>

			{/* Column border - right side (only for last column) */}
			{participant.columnIndex === 0 && (
				<line
					x1={x - LAYOUT.participantGap / 2 + columnWidth}
					y1={0}
					x2={x - LAYOUT.participantGap / 2 + columnWidth}
					y2={totalHeight}
					className="stroke-slate-200"
					strokeWidth={1}
				/>
			)}

			{/* Center line - dashed, subtle */}
			<line
				x1={centerX}
				y1={0}
				x2={centerX}
				y2={totalHeight}
				className="stroke-slate-300"
				strokeWidth={1}
				strokeDasharray="2 8"
			/>
		</g>
	)
}
