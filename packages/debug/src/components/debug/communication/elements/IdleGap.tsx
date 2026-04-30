import type { DiagramParticipant, TimeSegment } from '../types.js'
import { COLORS, LAYOUT } from '../types.js'

interface IdleGapProps {
	segment: TimeSegment
	participants: DiagramParticipant[]
	yPosition: number
	formatDuration: (ms: number) => string
}

export function IdleGap({ segment, participants, yPosition, formatDuration }: IdleGapProps) {
	const totalWidth = LAYOUT.timeAxisWidth + participants.length * (LAYOUT.participantWidth + LAYOUT.participantGap)
	const height = segment.displayHeight
	const centerX = (LAYOUT.timeAxisWidth + totalWidth) / 2

	return (
		<g className="idle-gap">
			{/* Background fill with gradient effect */}
			<rect
				x={LAYOUT.timeAxisWidth}
				y={yPosition + 2}
				width={totalWidth - LAYOUT.timeAxisWidth}
				height={height - 4}
				className="fill-slate-50"
				rx={2}
			/>

			{/* Top dashed line */}
			<line
				x1={LAYOUT.timeAxisWidth}
				y1={yPosition}
				x2={totalWidth}
				y2={yPosition}
				className={COLORS.idle.stroke}
				strokeWidth={1}
				strokeDasharray="4 4"
			/>

			{/* Bottom dashed line */}
			<line
				x1={LAYOUT.timeAxisWidth}
				y1={yPosition + height}
				x2={totalWidth}
				y2={yPosition + height}
				className={COLORS.idle.stroke}
				strokeWidth={1}
				strokeDasharray="4 4"
			/>

			{/* Duration label in center */}
			<g transform={`translate(${centerX}, ${yPosition + height / 2})`}>
				<rect
					x={-36}
					y={-10}
					width={72}
					height={20}
					rx={10}
					className="fill-white stroke-slate-200"
					strokeWidth={1}
				/>
				<text
					x={0}
					y={0}
					textAnchor="middle"
					dominantBaseline="middle"
					className={`text-[10px] ${COLORS.idle.text} fill-current`}
				>
					{formatDuration(segment.actualDuration)}
				</text>
			</g>

			{/* Vertical lane continuations (subtle dots) */}
			{participants.map((participant) => {
				const laneX = LAYOUT.timeAxisWidth + participant.columnIndex * (LAYOUT.participantWidth + LAYOUT.participantGap) + LAYOUT.participantWidth / 2
				return (
					<line
						key={participant.id}
						x1={laneX}
						y1={yPosition + 4}
						x2={laneX}
						y2={yPosition + height - 4}
						className={COLORS.idle.stroke}
						strokeWidth={1}
						strokeDasharray="2 6"
					/>
				)
			})}
		</g>
	)
}
