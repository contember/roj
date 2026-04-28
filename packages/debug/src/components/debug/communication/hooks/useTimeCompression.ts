import { useMemo } from 'react'
import type { TimeCompressionConfig, TimeSegment } from '../types'

const DEFAULT_CONFIG: TimeCompressionConfig = {
	pixelsPerSecond: 50,
	maxIdleHeight: 40,
	idleThresholdMs: 30000, // 30 seconds
}

export function useTimeCompression(
	timestamps: number[],
	config: Partial<TimeCompressionConfig> = {},
): {
	segments: TimeSegment[]
	totalHeight: number
	timestampToY: (timestamp: number) => number
	formatIdleDuration: (ms: number) => string
} {
	const mergedConfig = { ...DEFAULT_CONFIG, ...config }

	const segments = useMemo(() => {
		if (timestamps.length === 0) {
			return []
		}

		const sorted = [...timestamps].sort((a, b) => a - b)
		const result: TimeSegment[] = []

		let currentStart = sorted[0]
		let lastTimestamp = sorted[0]
		let isIdle = false

		for (let i = 1; i < sorted.length; i++) {
			const gap = sorted[i] - lastTimestamp

			if (gap > mergedConfig.idleThresholdMs && !isIdle) {
				// End active segment, start idle
				result.push({
					startTime: currentStart,
					endTime: lastTimestamp,
					type: 'active',
					displayHeight: Math.max(
						20,
						((lastTimestamp - currentStart) / 1000) * mergedConfig.pixelsPerSecond,
					),
					actualDuration: lastTimestamp - currentStart,
				})
				currentStart = lastTimestamp
				isIdle = true
			} else if (gap <= mergedConfig.idleThresholdMs && isIdle) {
				// End idle segment, start active
				result.push({
					startTime: currentStart,
					endTime: sorted[i],
					type: 'idle',
					displayHeight: mergedConfig.maxIdleHeight,
					actualDuration: sorted[i] - currentStart,
				})
				currentStart = sorted[i]
				isIdle = false
			}

			lastTimestamp = sorted[i]
		}

		// Close final segment
		if (currentStart !== lastTimestamp || result.length === 0) {
			result.push({
				startTime: currentStart,
				endTime: lastTimestamp,
				type: isIdle ? 'idle' : 'active',
				displayHeight: isIdle
					? mergedConfig.maxIdleHeight
					: Math.max(
						20,
						((lastTimestamp - currentStart) / 1000) * mergedConfig.pixelsPerSecond,
					),
				actualDuration: lastTimestamp - currentStart,
			})
		}

		return result
	}, [timestamps, mergedConfig.idleThresholdMs, mergedConfig.pixelsPerSecond, mergedConfig.maxIdleHeight])

	const totalHeight = useMemo(() => {
		return segments.reduce((sum, seg) => sum + seg.displayHeight, 0)
	}, [segments])

	const timestampToY = useMemo(() => {
		return (timestamp: number): number => {
			let y = 0

			for (const segment of segments) {
				if (timestamp < segment.startTime) {
					return y
				}

				if (timestamp <= segment.endTime) {
					if (segment.type === 'idle') {
						// Linear interpolation within idle segment
						const progress = (timestamp - segment.startTime) / (segment.endTime - segment.startTime)
						return y + progress * segment.displayHeight
					} else {
						// Active segment: proportional to time
						const segmentDuration = segment.endTime - segment.startTime
						if (segmentDuration === 0) {
							return y
						}
						const progress = (timestamp - segment.startTime) / segmentDuration
						return y + progress * segment.displayHeight
					}
				}

				y += segment.displayHeight
			}

			return y
		}
	}, [segments])

	const formatIdleDuration = (ms: number): string => {
		const seconds = Math.floor(ms / 1000)
		const minutes = Math.floor(seconds / 60)
		const hours = Math.floor(minutes / 60)
		const days = Math.floor(hours / 24)

		if (days > 0) {
			return `${days}d ${hours % 24}h idle`
		}
		if (hours > 0) {
			return `${hours}h ${minutes % 60}m idle`
		}
		if (minutes > 0) {
			return `${minutes}m idle`
		}
		return `${seconds}s idle`
	}

	return { segments, totalHeight, timestampToY, formatIdleDuration }
}
