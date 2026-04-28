import { useCallback, useEffect, useRef, useState } from 'react'
import type { ZoomPanState } from '../types'

const MIN_ZOOM = 0.25
const MAX_ZOOM = 4
const ZOOM_STEP = 0.25

export function useZoomPan(totalHeight: number) {
	const [state, setState] = useState<ZoomPanState>({
		zoom: 1,
		scrollY: 0,
		autoScroll: true,
	})

	const containerRef = useRef<HTMLDivElement>(null)
	const prevTotalHeightRef = useRef(totalHeight)

	// Auto-scroll to bottom when new content arrives
	useEffect(() => {
		if (state.autoScroll && totalHeight > prevTotalHeightRef.current && containerRef.current) {
			containerRef.current.scrollTop = containerRef.current.scrollHeight
		}
		prevTotalHeightRef.current = totalHeight
	}, [totalHeight, state.autoScroll])

	const zoomIn = useCallback(() => {
		setState((prev) => ({
			...prev,
			zoom: Math.min(MAX_ZOOM, prev.zoom + ZOOM_STEP),
		}))
	}, [])

	const zoomOut = useCallback(() => {
		setState((prev) => ({
			...prev,
			zoom: Math.max(MIN_ZOOM, prev.zoom - ZOOM_STEP),
		}))
	}, [])

	const resetZoom = useCallback(() => {
		setState((prev) => ({
			...prev,
			zoom: 1,
		}))
	}, [])

	const toggleAutoScroll = useCallback(() => {
		setState((prev) => ({
			...prev,
			autoScroll: !prev.autoScroll,
		}))
	}, [])

	const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
		const target = e.target as HTMLDivElement
		const isAtBottom = Math.abs(target.scrollHeight - target.clientHeight - target.scrollTop) < 10

		setState((prev) => ({
			...prev,
			scrollY: target.scrollTop,
			// Disable auto-scroll if user scrolled up manually
			autoScroll: prev.autoScroll ? isAtBottom : prev.autoScroll,
		}))
	}, [])

	const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
		if (e.ctrlKey || e.metaKey) {
			e.preventDefault()
			const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP
			setState((prev) => ({
				...prev,
				zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, prev.zoom + delta)),
			}))
		}
	}, [])

	return {
		state,
		containerRef,
		zoomIn,
		zoomOut,
		resetZoom,
		toggleAutoScroll,
		handleScroll,
		handleWheel,
	}
}
