import { useSessionStore } from './stores/session-store.js'

export function useSessionState(): Record<string, unknown> {
	return useSessionStore((s) => s.sessionState)
}

export function useSessionStateValue<T = unknown>(key: string): T | undefined {
	return useSessionStore((s) => s.sessionState[key]) as T | undefined
}

export function useUpdateSessionState(): (updates: Record<string, unknown>) => Promise<void> {
	return useSessionStore((s) => s.updateSessionState)
}
