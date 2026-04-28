/**
 * Unified navigation utilities for debug UI.
 *
 * All navigation goes through DebugContext, which is provided by the host app
 * (admin via buzola, worker SPA via react-router, etc.).
 */

import type { SessionId } from '@roj-ai/shared'
import type { ReactNode } from 'react'
import { useCallback } from 'react'
import { useDebugContext } from './DebugContext'

/**
 * Get the session ID from the debug context.
 */
export function useDebugSessionId(): SessionId {
	return useDebugContext().sessionId
}

/**
 * Get route params from the debug context.
 */
export function useDebugParams<T extends Record<string, string | undefined>>(): T {
	return useDebugContext().params as T
}

/**
 * Navigate to a debug subpath (e.g., "agents/abc123", "llm-calls/xyz").
 */
export function useDebugNavigate(): (subpath: string) => void {
	const { navigate } = useDebugContext()
	return useCallback((subpath: string) => navigate(subpath), [navigate])
}

/**
 * Link component for debug navigation.
 * Renders an <a> tag with proper href for right-click/open-in-new-tab support.
 */
export function DebugLink({ to, className, children }: { to: string; className?: string; children: ReactNode }) {
	const { navigate, createHref } = useDebugContext()

	return (
		<a
			href={createHref(to)}
			className={className}
			onClick={(e) => {
				if (e.metaKey || e.ctrlKey || e.shiftKey) return
				e.preventDefault()
				navigate(to)
			}}
		>
			{children}
		</a>
	)
}
