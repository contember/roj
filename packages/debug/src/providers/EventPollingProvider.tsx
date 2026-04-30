import { useEffect } from 'react'
import { useEventStore } from '../stores/event-store.js'

interface EventPollingProviderProps {
	sessionId: string
	children: React.ReactNode
}

/**
 * Provider component that manages event polling for a session.
 *
 * When mounted, it loads the session's events and starts polling for new events.
 * When unmounted (e.g., navigating away), it stops polling and resets the store.
 *
 * Usage:
 * ```tsx
 * <EventPollingProvider sessionId={sessionId}>
 *   <DebugViews />
 * </EventPollingProvider>
 * ```
 */
export function EventPollingProvider({ sessionId, children }: EventPollingProviderProps) {
	const loadSession = useEventStore((s) => s.loadSession)
	const reset = useEventStore((s) => s.reset)

	useEffect(() => {
		loadSession(sessionId)

		// Cleanup on unmount or sessionId change
		return () => {
			reset()
		}
	}, [sessionId, loadSession, reset])

	return <>{children}</>
}

/**
 * Hook to initialize event polling for a session.
 * Use this instead of EventPollingProvider if you want more control.
 */
export function useEventPolling(sessionId: string | undefined) {
	const loadSession = useEventStore((s) => s.loadSession)
	const reset = useEventStore((s) => s.reset)
	const isLoading = useEventStore((s) => s.isLoading)
	const error = useEventStore((s) => s.error)

	useEffect(() => {
		if (!sessionId) return

		loadSession(sessionId)

		// Cleanup on unmount or sessionId change
		return () => {
			reset()
		}
	}, [sessionId, loadSession, reset])

	return { isLoading, error }
}
