import type { SessionId } from '@roj-ai/shared'
import { createContext, useContext } from 'react'

export interface DebugContextValue {
	sessionId: SessionId
	params: Record<string, string | undefined>
	navigate: (subpath: string) => void
	createHref: (subpath: string) => string
	isActive: (subpath: string) => boolean
}

export const DebugContext = createContext<DebugContextValue | null>(null)

export function useDebugContext(): DebugContextValue {
	const ctx = useContext(DebugContext)
	if (!ctx) throw new Error('useDebugContext must be used within a DebugContext.Provider')
	return ctx
}
