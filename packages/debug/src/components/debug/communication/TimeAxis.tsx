import type { TimeSegment } from './types'
import { LAYOUT } from './types'

interface TimeAxisProps {
	segments: TimeSegment[]
	sessionStartTime: number
	timestampToY: (timestamp: number) => number
	totalHeight: number
}

export function TimeAxis({ segments, sessionStartTime, timestampToY, totalHeight }: TimeAxisProps) {
	// Generate time markers every ~80px on active segments
	const markers: Array<{ timestamp: number; y: number; label: string }> = []

	for (const segment of segments) {
		if (segment.type === 'idle') continue

		const interval = calculateInterval(segment.actualDuration)
		let current = segment.startTime

		while (current <= segment.endTime) {
			const y = timestampToY(current)
			// Only add if not too close to previous marker
			const lastMarker = markers[markers.length - 1]
			if (!lastMarker || y - lastMarker.y > 40) {
				markers.push({
					timestamp: current,
					y,
					label: formatTime(current, sessionStartTime),
				})
			}
			current += interval
		}
	}

	return (
		<g className="time-axis">
			{/* Vertical axis line */}
			<line
				x1={LAYOUT.timeAxisWidth - 1}
				y1={0}
				x2={LAYOUT.timeAxisWidth - 1}
				y2={totalHeight}
				className="stroke-slate-100"
				strokeWidth={1}
			/>

			{/* Time markers */}
			{markers.map((marker, idx) => (
				<g key={idx}>
					{/* Tick mark */}
					<line
						x1={LAYOUT.timeAxisWidth - 6}
						y1={marker.y}
						x2={LAYOUT.timeAxisWidth - 1}
						y2={marker.y}
						className="stroke-slate-200"
						strokeWidth={1}
					/>

					{/* Time label */}
					<text
						x={LAYOUT.timeAxisWidth - 10}
						y={marker.y}
						textAnchor="end"
						dominantBaseline="middle"
						className="text-[9px] text-slate-400 fill-current font-mono"
					>
						{marker.label}
					</text>

					{/* Subtle horizontal guide line */}
					<line
						x1={LAYOUT.timeAxisWidth}
						y1={marker.y}
						x2={LAYOUT.timeAxisWidth + 2000}
						y2={marker.y}
						className="stroke-slate-50"
						strokeWidth={1}
					/>
				</g>
			))}
		</g>
	)
}

function calculateInterval(durationMs: number): number {
	// Choose interval based on duration to get ~5-10 markers per segment
	if (durationMs < 10000) return 2000 // Every 2s for < 10s
	if (durationMs < 60000) return 10000 // Every 10s for < 1min
	if (durationMs < 300000) return 30000 // Every 30s for < 5min
	if (durationMs < 3600000) return 60000 // Every 1min for < 1h
	return 300000 // Every 5min for > 1h
}

function formatTime(timestamp: number, sessionStartTime: number): string {
	const elapsed = timestamp - sessionStartTime
	const seconds = Math.floor(elapsed / 1000)
	const minutes = Math.floor(seconds / 60)
	const hours = Math.floor(minutes / 60)

	if (hours > 0) {
		return `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
	}
	return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}
