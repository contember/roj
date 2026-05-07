import { useEffect } from 'react'
import { useEventStore } from '../stores/event-store.js'

const IDLE_TIMEOUT_MS = 2 * 60 * 1000
const ACTIVITY_EVENTS = ['mousedown', 'mousemove', 'keydown', 'touchstart', 'scroll', 'wheel'] as const

interface EventPollingProviderProps {
	sessionId: string
	children: React.ReactNode
}

/**
 * Provider component that manages event polling for a session.
 *
 * Polling is paused when the tab is hidden or the user has been idle for
 * IDLE_TIMEOUT_MS. It resumes (and immediately catches up) on activity or
 * tab refocus. Unmounting clears polling and resets the store.
 */
export function EventPollingProvider({ sessionId, children }: EventPollingProviderProps) {
	useEventPolling(sessionId)
	return <>{children}</>
}

/**
 * Hook variant of EventPollingProvider for callers that need access to
 * isLoading / error.
 */
export function useEventPolling(sessionId: string | undefined) {
	const loadSession = useEventStore((s) => s.loadSession)
	const reset = useEventStore((s) => s.reset)
	const startPolling = useEventStore((s) => s.startPolling)
	const stopPolling = useEventStore((s) => s.stopPolling)
	const fetchNewEvents = useEventStore((s) => s.fetchNewEvents)
	const isLoading = useEventStore((s) => s.isLoading)
	const error = useEventStore((s) => s.error)

	useEffect(() => {
		if (!sessionId) return

		let idleTimer: ReturnType<typeof setTimeout> | null = null
		let isIdle = false
		let cancelled = false

		const reconcile = () => {
			if (cancelled) return
			const state = useEventStore.getState()
			if (state.sessionId !== sessionId || state.isLoading) return
			const shouldPoll = document.visibilityState === 'visible' && !isIdle
			if (shouldPoll && !state.isPolling) {
				fetchNewEvents()
				startPolling()
			} else if (!shouldPoll && state.isPolling) {
				stopPolling()
			}
		}

		const onActivity = () => {
			if (idleTimer) clearTimeout(idleTimer)
			if (isIdle) {
				isIdle = false
				reconcile()
			}
			idleTimer = setTimeout(() => {
				isIdle = true
				reconcile()
			}, IDLE_TIMEOUT_MS)
		}

		const onVisibility = () => reconcile()

		for (const ev of ACTIVITY_EVENTS) {
			window.addEventListener(ev, onActivity, { passive: true })
		}
		document.addEventListener('visibilitychange', onVisibility)

		// Reconcile after the initial load finishes — loadSession auto-starts
		// polling on success, so we need to immediately stop it if the tab is
		// hidden / user is idle at that moment.
		const unsubscribe = useEventStore.subscribe((state, prev) => {
			if (state.sessionId !== sessionId) return
			if (state.isLoading !== prev.isLoading) reconcile()
		})

		onActivity() // arm the idle timer
		loadSession(sessionId)

		return () => {
			cancelled = true
			if (idleTimer) clearTimeout(idleTimer)
			for (const ev of ACTIVITY_EVENTS) {
				window.removeEventListener(ev, onActivity)
			}
			document.removeEventListener('visibilitychange', onVisibility)
			unsubscribe()
			reset()
		}
	}, [sessionId, loadSession, reset, startPolling, stopPolling, fetchNewEvents])

	return { isLoading, error }
}
