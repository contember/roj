import type { SessionId } from '@roj-ai/shared'
import { useCallback, useEffect, useRef, useState } from 'react'
import { configureApiBaseUrl } from '@roj-ai/client'
import { buildApiBaseUrl, buildWsUrl } from '@roj-ai/client/platform'
import { useConnectionStore, configureConnectionUrl } from './stores/connection-store'
import { useSessionStore, type ServiceInfo } from './stores/session-store'

/**
 * Auth token for a roj instance. Pass a plain string for a static (non-refreshing)
 * token, or an object with a `refresh()` callback to have `useChat` auto-renew the
 * token before it expires. The host typically wires `refresh` to a server endpoint
 * that calls `tokens.create` on the platform.
 */
export type ChatTokenSource =
	| string
	| {
		initial: ChatTokenSnapshot
		refresh: () => Promise<ChatTokenSnapshot>
		/** Trigger refresh this many ms before `expiresAt` (default 30000). */
		refreshLeadMs?: number
	}

export interface ChatTokenSnapshot {
	token: string
	/** ISO 8601 timestamp. Omit for tokens that don't expire. */
	expiresAt?: string
	/** Optional preview URLs keyed by service code, e.g. from `tokens.create({ previewServiceCodes })`. */
	previewUrls?: Record<string, string>
}

export interface UseChatOptions {
	/** Platform URL (e.g. https://roj.example.com) */
	platformUrl: string
	/** Instance ID */
	instanceId: string
	/** Session ID */
	sessionId: string
	/** Instance token for authentication. String for static; object for self-refreshing. */
	token: ChatTokenSource
	/** Whether to auto-connect on mount (default: true) */
	autoConnect?: boolean
	/** Called for every WebSocket message (type, payload) — escape hatch for custom types */
	onMessage?: (type: string, payload: unknown) => void
	/** Service types to ensure are started (e.g. ['dev']). Best-effort: triggers start and polls for readiness. */
	services?: string[]
}

export interface ChatState {
	// Connection state
	connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error'
	isConnected: boolean

	// Session state
	messages: ReturnType<typeof useSessionStore.getState>['messages']
	pendingQuestions: ReturnType<typeof useSessionStore.getState>['pendingQuestions']
	isAgentTyping: boolean
	isAgentConnected: boolean
	error: string | null

	// Attachments
	pendingAttachments: ReturnType<typeof useSessionStore.getState>['pendingAttachments']

	// Services (dev preview, etc.)
	services: Map<string, ServiceInfo>

	// Instance init progress
	initStatus: 'connecting' | 'initializing' | 'ready' | 'failed'
	initSteps: Array<{ step: string; detail?: string; timestamp: number }>

	// Auth — reactive view of the current token and any preview URLs derived from it.
	// Rotates automatically when the host supplied a refreshable `ChatTokenSource`.
	currentToken: string
	previewUrls: Record<string, string>

	// Actions
	sendMessage: (content: string) => Promise<void>
	uploadFile: (file: File) => Promise<void>
	removeAttachment: (uploadId: string) => void
	answerQuestion: (questionId: string, answer: unknown) => Promise<void>
	setDraftAnswer: (questionId: string, answer: unknown) => void
	submitAllAnswers: () => Promise<void>
}

/**
 * All-in-one hook for connecting to a roj platform instance.
 *
 * Configures WebSocket + RPC URLs, manages connection lifecycle,
 * and exposes reactive chat state (messages, services, init progress).
 *
 * @example
 * ```tsx
 * const chat = useChat({
 *   platformUrl: 'https://roj.example.com',
 *   instanceId: '...',
 *   sessionId: '...',
 *   token: '...',
 * })
 *
 * if (chat.initStatus !== 'ready') return <Loading steps={chat.initSteps} />
 *
 * return (
 *   <div>
 *     <MessageList messages={chat.messages} isAgentTyping={chat.isAgentTyping} />
 *     <MessageInput />
 *   </div>
 * )
 * ```
 */
const DEFAULT_REFRESH_LEAD_MS = 30_000

function normalizeTokenSource(source: ChatTokenSource): ChatTokenSnapshot {
	if (typeof source === 'string') {
		return { token: source }
	}
	return source.initial
}

export function useChat(options: UseChatOptions): ChatState {
	const { platformUrl, instanceId, sessionId, token, autoConnect = true, onMessage } = options

	// Connection store
	const connectionStatus = useConnectionStore((s) => s.status)
	const disconnect = useConnectionStore((s) => s.disconnect)
	const addMessageHandler = useConnectionStore((s) => s.addMessageHandler)
	const removeMessageHandler = useConnectionStore((s) => s.removeMessageHandler)

	// Token state — kept in a ref for the WS URL builder (re-read on every reconnect)
	// AND in React state so consumers (preview iframe etc.) re-render when it rotates.
	const [tokenSnapshot, setTokenSnapshot] = useState<ChatTokenSnapshot>(() => normalizeTokenSource(token))
	const tokenSnapshotRef = useRef(tokenSnapshot)
	tokenSnapshotRef.current = tokenSnapshot

	// Identity-stable refresh callback so the refresh effect doesn't restart on every render.
	const refreshFnRef = useRef<(() => Promise<ChatTokenSnapshot>) | null>(null)
	const refreshLeadMsRef = useRef(DEFAULT_REFRESH_LEAD_MS)
	if (typeof token === 'string') {
		refreshFnRef.current = null
	} else {
		refreshFnRef.current = token.refresh
		refreshLeadMsRef.current = token.refreshLeadMs ?? DEFAULT_REFRESH_LEAD_MS
	}

	// `refreshNonce` bump re-runs the refresh effect after a transient failure
	// without rotating the snapshot itself.
	const [refreshNonce, setRefreshNonce] = useState(0)

	// Schedule the next refresh based on the most recent snapshot's expiresAt.
	// biome-ignore lint/correctness/useExhaustiveDependencies: refreshNonce intentionally retriggers the effect after a failed refresh
	useEffect(() => {
		if (!refreshFnRef.current || !tokenSnapshot.expiresAt) return
		const expiresAtMs = new Date(tokenSnapshot.expiresAt).getTime()
		if (Number.isNaN(expiresAtMs)) return

		let cancelled = false
		let retryHandle: ReturnType<typeof setTimeout> | undefined

		const fireInMs = Math.max(expiresAtMs - Date.now() - refreshLeadMsRef.current, 1000)
		const handle = setTimeout(async () => {
			if (cancelled) return
			try {
				const fresh = await refreshFnRef.current!()
				if (!cancelled) setTokenSnapshot(fresh)
			} catch (err) {
				if (cancelled) return
				console.error('[useChat] Token refresh failed:', err)
				// Retry after a short backoff so a transient failure doesn't strand the session.
				retryHandle = setTimeout(() => {
					if (!cancelled) setRefreshNonce((n) => n + 1)
				}, 5000)
			}
		}, fireInMs)

		return () => {
			cancelled = true
			clearTimeout(handle)
			if (retryHandle) clearTimeout(retryHandle)
		}
	}, [tokenSnapshot, refreshNonce])

	// Session store
	const messages = useSessionStore((s) => s.messages)
	const pendingQuestions = useSessionStore((s) => s.pendingQuestions)
	const isAgentTyping = useSessionStore((s) => s.isAgentTyping)
	const isAgentConnected = useSessionStore((s) => s.isAgentConnected)
	const error = useSessionStore((s) => s.error)
	const pendingAttachments = useSessionStore((s) => s.pendingAttachments)
	const services = useSessionStore((s) => s.services)
	const initStatus = useSessionStore((s) => s.initStatus)
	const initSteps = useSessionStore((s) => s.initSteps)
	const handleServerMessage = useSessionStore((s) => s.handleServerMessage)
	const sendMessage = useSessionStore((s) => s.sendMessage)
	const uploadFile = useSessionStore((s) => s.uploadFile)
	const removeAttachment = useSessionStore((s) => s.removeAttachment)
	const answerQuestion = useSessionStore((s) => s.answerQuestion)
	const setDraftAnswer = useSessionStore((s) => s.setDraftAnswer)
	const submitAllAnswers = useSessionStore((s) => s.submitAllAnswers)
	const clearSession = useSessionStore((s) => s.clearSession)
	const loadSession = useSessionStore((s) => s.loadSession)

	const fetchServiceUrl = useSessionStore((s) => s.fetchServiceUrl)

	const sessionIdRef = useRef(sessionId)
	const instanceIdRef = useRef(instanceId)
	sessionIdRef.current = sessionId
	instanceIdRef.current = instanceId

	const onMessageRef = useRef(onMessage)
	onMessageRef.current = onMessage

	// Configure URLs + connect.
	// The WS URL builder closes over `tokenSnapshotRef`, so token rotations are
	// picked up on the next reconnect without re-running this effect (which would
	// tear down the live socket).
	useEffect(() => {
		if (!autoConnect) return

		configureConnectionUrl((_pid: string, sid: string) => {
			return buildWsUrl({ platformUrl, instanceId, sessionId: sid, token: tokenSnapshotRef.current.token })
		})
		configureApiBaseUrl(buildApiBaseUrl(platformUrl, instanceId))

		loadSession(sessionId as unknown as SessionId, instanceId).catch((err) => {
			console.error('[useChat] Session load failed:', err)
		})

		return () => {
			disconnect()
			clearSession()
		}
	}, [autoConnect, platformUrl, instanceId, sessionId, loadSession, disconnect, clearSession])

	// Auto-recover on connection drop
	const sessionStatus = useSessionStore((s) => s.status)
	const reconnectAttemptsRef = useRef(0)
	useEffect(() => {
		if (connectionStatus === 'connected') {
			reconnectAttemptsRef.current = 0
		}
	}, [connectionStatus])

	useEffect(() => {
		if (!autoConnect) return
		if (connectionStatus !== 'disconnected' && connectionStatus !== 'error') return
		if (sessionStatus === 'idle') return
		if (reconnectAttemptsRef.current >= 3) return

		const timer = setTimeout(() => {
			reconnectAttemptsRef.current++
			loadSession(sessionIdRef.current as unknown as SessionId, instanceIdRef.current).catch((err) => {
				console.error('[useChat] Session reconnect failed:', err)
			})
		}, 2000)

		return () => clearTimeout(timer)
	}, [autoConnect, connectionStatus, sessionStatus, loadSession])

	// Ensure requested services are started
	const requestedServices = options.services
	useEffect(() => {
		if (!requestedServices?.length || sessionStatus !== 'active' || !sessionId) return
		const currentServices = useSessionStore.getState().services
		for (const serviceType of requestedServices) {
			const existing = currentServices.get(serviceType)
			if (!existing || existing.status !== 'ready') {
				fetchServiceUrl(instanceId, sessionId, serviceType)
			}
		}
	}, [sessionStatus, sessionId, instanceId, fetchServiceUrl, requestedServices])

	// Message handler: updates store + fires onMessage callback
	const combinedHandler = useCallback((type: string, payload: unknown) => {
		handleServerMessage(type, payload)
		onMessageRef.current?.(type, payload)
	}, [handleServerMessage])

	useEffect(() => {
		const handlerId = `chat-${sessionId}`
		addMessageHandler(handlerId, combinedHandler)
		return () => removeMessageHandler(handlerId)
	}, [sessionId, combinedHandler, addMessageHandler, removeMessageHandler])

	return {
		connectionStatus,
		isConnected: connectionStatus === 'connected',
		messages,
		pendingQuestions,
		isAgentTyping,
		isAgentConnected,
		error,
		pendingAttachments,
		services,
		initStatus,
		initSteps,
		currentToken: tokenSnapshot.token,
		previewUrls: tokenSnapshot.previewUrls ?? {},
		sendMessage,
		uploadFile,
		removeAttachment,
		answerQuestion,
		setDraftAnswer,
		submitAllAnswers,
	}
}
