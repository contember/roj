import type { SessionId } from '@roj-ai/shared'
import { useCallback, useEffect, useRef } from 'react'
import { configureApiBaseUrl } from '@roj-ai/client'
import { buildApiBaseUrl, buildWsUrl } from '@roj-ai/client/platform'
import { useConnectionStore, configureConnectionUrl } from './stores/connection-store'
import { useSessionStore, type ServiceInfo } from './stores/session-store'

export interface UseChatOptions {
	/** Platform URL (e.g. https://roj.example.com) */
	platformUrl: string
	/** Instance ID */
	instanceId: string
	/** Session ID */
	sessionId: string
	/** Instance token for authentication */
	token: string
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
export function useChat(options: UseChatOptions): ChatState {
	const { platformUrl, instanceId, sessionId, token, autoConnect = true, onMessage } = options

	// Connection store
	const connectionStatus = useConnectionStore((s) => s.status)
	const disconnect = useConnectionStore((s) => s.disconnect)
	const addMessageHandler = useConnectionStore((s) => s.addMessageHandler)
	const removeMessageHandler = useConnectionStore((s) => s.removeMessageHandler)

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

	// Configure URLs + connect
	useEffect(() => {
		if (!autoConnect) return

		configureConnectionUrl((_pid: string, sid: string) => {
			return buildWsUrl({ platformUrl, instanceId, sessionId: sid, token })
		})
		configureApiBaseUrl(buildApiBaseUrl(platformUrl, instanceId))

		loadSession(sessionId as unknown as SessionId, instanceId).catch((err) => {
			console.error('[useChat] Session load failed:', err)
		})

		return () => {
			disconnect()
			clearSession()
		}
	}, [autoConnect, platformUrl, instanceId, sessionId, token, loadSession, disconnect, clearSession])

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
		sendMessage,
		uploadFile,
		removeAttachment,
		answerQuestion,
		setDraftAnswer,
		submitAllAnswers,
	}
}
