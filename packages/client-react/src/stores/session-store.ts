import type { AskUserInputType, ChatMessage } from '@roj-ai/shared'
import { AgentId, ChatMessageId, SessionId } from '@roj-ai/shared'
import { useEffect } from 'react'
import { create } from 'zustand'
import { api, configureProjectId, instanceApi, unwrap } from '@roj-ai/client'
import { useConnectionStore } from './connection-store.js'

function isChatMessage(msg: unknown): msg is ChatMessage {
	return typeof msg === 'object' && msg !== null && 'type' in msg && 'timestamp' in msg
}

export interface PendingQuestion {
	questionId: string
	question: string
	inputType: AskUserInputType
	timestamp: number
}

interface PendingMessageData {
	content: string
	timestamp: number
}

export type QuestionSubmitStatus = 'idle' | 'submitting' | 'success' | 'error'

export interface PendingAttachment {
	uploadId: string
	filename: string
	status: 'uploading' | 'ready' | 'failed'
	error?: string
}

export interface ServiceInfo {
	serviceType: string
	status: string
	port?: number
	code?: string
}

interface SessionState {
	sessionId: SessionId | null
	projectId: string | null
	presetId: string | null
	entryAgentId: string | null
	status: 'idle' | 'loading' | 'active' | 'closed' | 'error'
	messages: ChatMessage[]
	pendingQuestions: PendingQuestion[]
	draftAnswers: Map<string, unknown>
	questionSubmitStatus: Map<string, QuestionSubmitStatus>
	isAgentTyping: boolean
	isAgentConnected: boolean
	error: string | null

	// Optimistic messages (before server ack)
	pendingMessages: Map<string, PendingMessageData>

	// Pending attachments for next message
	pendingAttachments: Map<string, PendingAttachment>

	// Message context (invisible to user, visible to LLM)
	messageContext: string | null

	// Services (dev preview, etc.)
	services: Map<string, ServiceInfo>

	// Session state (from sessionState plugin)
	sessionState: Record<string, unknown>

	// Instance init progress (received via WebSocket)
	initStatus: 'connecting' | 'initializing' | 'ready' | 'failed'
	initSteps: Array<{ step: string; detail?: string; timestamp: number }>

	// Actions
	loadSession: (sessionId: SessionId, projectId: string) => Promise<void>
	sendMessage: (content: string) => Promise<void>
	uploadFile: (file: File) => Promise<void>
	removeAttachment: (uploadId: string) => void
	answerQuestion: (questionId: string, answer: unknown) => Promise<void>
	setDraftAnswer: (questionId: string, answer: unknown) => void
	submitAllAnswers: () => Promise<void>
	setMessageContext: (context: string | null) => void
	clearSession: () => void
	fetchServiceUrl: (instanceId: string, sessionId: string, serviceType: string) => void
	fetchAllServiceUrls: (sessionId: string) => void
	updateSessionState: (updates: Record<string, unknown>) => Promise<void>

	// Internal
	handleServerMessage: (type: string, payload: unknown) => void
}

let loadGeneration = 0

export const useSessionStore = create<SessionState>((set, get) => ({
	sessionId: null,
	projectId: null,
	presetId: null,
	entryAgentId: null,
	status: 'idle',
	messages: [],
	pendingQuestions: [],
	draftAnswers: new Map(),
	questionSubmitStatus: new Map(),
	isAgentTyping: false,
	isAgentConnected: false,
	error: null,
	pendingMessages: new Map(),
	pendingAttachments: new Map(),
	messageContext: null,
	services: new Map(),
	sessionState: {},
	initStatus: 'connecting',
	initSteps: [],

	loadSession: async (sessionId, projectId) => {
		const thisGeneration = ++loadGeneration
		set({ status: 'loading', error: null, sessionId, projectId })

		// Configure project ID for RPC calls (adds ?project= to /rpc requests)
		configureProjectId(projectId)

		try {
			// Connect to the project with sessionId (subscription is implicit via URL)
			await useConnectionStore.getState().connect(projectId, sessionId)

			// Stale check: a newer loadSession was called while we were connecting
			if (thisGeneration !== loadGeneration) return

			// Load session info
			const session = unwrap(await api.call('sessions.get', { sessionId }))
			if (session.status === 'closed') {
				set({ status: 'closed' })
				return
			}

			// Load messages
			const messagesResult = unwrap(await api.call('user-chat.getMessages', { sessionId }))
			const messages = messagesResult.messages.filter(isChatMessage)

			// Load pending (unused) uploads
			const { uploads: pendingUploads } = unwrap(await api.call('uploads.listPending', { sessionId }))
			const restoredAttachments = new Map<string, PendingAttachment>()
			for (const upload of pendingUploads) {
				restoredAttachments.set(upload.uploadId, {
					uploadId: upload.uploadId,
					filename: upload.filename,
					status: upload.status === 'ready' ? 'ready' : upload.status === 'failed' ? 'failed' : 'uploading',
				})
			}

			// Find ALL pending questions
			const pendingQuestionMsgs = messages.filter(
				(m): m is Extract<ChatMessage, { type: 'ask_user' }> => m.type === 'ask_user' && !m.answered,
			)

			// Stale check before writing final state
			if (thisGeneration !== loadGeneration) return

			set({
				status: 'active',
				error: null,
				presetId: session.presetId,
				entryAgentId: session.entryAgentId,
				messages,
				pendingAttachments: restoredAttachments,
				pendingQuestions: pendingQuestionMsgs.map((msg) => ({
					questionId: msg.questionId,
					question: msg.question,
					inputType: msg.inputType,
					timestamp: msg.timestamp,
				})),
				draftAnswers: new Map(),
				questionSubmitStatus: new Map(),
				// If agents are already connected, mark init as ready immediately
				// (initProgress messages were sent before this client connected)
				...(session.agentCount > 0 ? { initStatus: 'ready' as const, isAgentConnected: true } : {}),
			})

			// Fetch service URLs eagerly — don't wait for WS notification
			get().fetchAllServiceUrls(sessionId)

			// Fetch session state (plugin may not be configured — ignore errors)
			api.call('sessionState.get', { sessionId })
				.then(result => {
					if (result.ok && typeof result.value === 'object' && result.value !== null && 'state' in result.value) {
						set({ sessionState: (result.value as { state: Record<string, unknown> }).state })
					}
				})
				.catch(() => {/* sessionState plugin not configured */})
		} catch (error) {
			// Only set error if this is still the latest load attempt
			if (thisGeneration !== loadGeneration) return
			set({
				status: 'error',
				error: error instanceof Error ? error.message : 'Failed to load session',
			})
		}
	},

	sendMessage: async (content) => {
		const { sessionId, entryAgentId, pendingQuestions, pendingAttachments } = get()
		if (!sessionId || !entryAgentId || pendingQuestions.length > 0) return

		// Collect ready attachments for display
		const readyAttachments = Array.from(pendingAttachments.values()).filter(
			(a) => a.status === 'ready',
		)

		// Don't send if no content and no attachments
		if (!content.trim() && readyAttachments.length === 0) return

		const messageId = ChatMessageId(crypto.randomUUID())
		const timestamp = Date.now()

		// Build display content
		const displayContent = content.trim() || readyAttachments.map((a) => `[File: ${a.filename}]`).join(' ')

		// Optimistic update - add to pending
		const pendingMessages = new Map(get().pendingMessages)
		pendingMessages.set(messageId, { content: displayContent, timestamp })
		set({ pendingMessages })

		// Add to messages immediately
		set({
			messages: [
				...get().messages,
				{
					type: 'user_message',
					messageId,
					content: displayContent,
					timestamp,
				},
			],
		})

		// Send via REST API
		try {
			// Use content or a placeholder if only attachments
			const messageContent = content.trim() || (readyAttachments.length > 0 ? `[${readyAttachments.map((a) => a.filename).join(', ')}]` : '')
			unwrap(await api.call('user-chat.sendMessage', { sessionId, agentId: AgentId(entryAgentId), content: messageContent }))
			// Remove from pending on success and clear attachments
			const newPendingMessages = new Map(get().pendingMessages)
			newPendingMessages.delete(messageId)
			set({ pendingMessages: newPendingMessages, pendingAttachments: new Map() })
		} catch (error) {
			console.error('Failed to send message:', error)
			// Remove from pending and messages on error
			const newPendingMessages = new Map(get().pendingMessages)
			newPendingMessages.delete(messageId)
			set({
				pendingMessages: newPendingMessages,
				messages: get().messages.filter((m) => m.type !== 'user_message' || m.messageId !== messageId),
				error: error instanceof Error ? error.message : 'Failed to send message',
			})
		}
	},

	uploadFile: async (file) => {
		const { sessionId } = get()
		if (!sessionId) return

		// Generate temporary ID for tracking
		const tempId = crypto.randomUUID()

		// Add to pending with uploading status
		const newAttachments = new Map(get().pendingAttachments)
		newAttachments.set(tempId, {
			uploadId: tempId,
			filename: file.name,
			status: 'uploading',
		})
		set({ pendingAttachments: newAttachments })

		try {
			const result = await api.uploadFile(sessionId, file)

			// Update with real uploadId and status
			const updatedAttachments = new Map(get().pendingAttachments)
			updatedAttachments.delete(tempId)
			updatedAttachments.set(result.uploadId, {
				uploadId: result.uploadId,
				filename: file.name,
				status: result.status,
				error: result.status === 'failed' ? 'Processing failed' : undefined,
			})
			set({ pendingAttachments: updatedAttachments })
		} catch (error) {
			console.error('Failed to upload file:', error)
			// Update with error status
			const updatedAttachments = new Map(get().pendingAttachments)
			updatedAttachments.set(tempId, {
				uploadId: tempId,
				filename: file.name,
				status: 'failed',
				error: error instanceof Error ? error.message : 'Upload failed',
			})
			set({ pendingAttachments: updatedAttachments })
		}
	},

	removeAttachment: (uploadId) => {
		const { sessionId } = get()
		const attachment = get().pendingAttachments.get(uploadId)

		// Remove from UI immediately
		const newAttachments = new Map(get().pendingAttachments)
		newAttachments.delete(uploadId)
		set({ pendingAttachments: newAttachments })

		// Delete on server (fire and forget - upload is already removed from UI)
		if (sessionId && attachment && attachment.status === 'ready') {
			api.call('uploads.delete', { sessionId, uploadId }).then(r => unwrap(r)).catch((error: unknown) => {
				console.error('Failed to delete upload on server:', error)
			})
		}
	},

	answerQuestion: async (questionId, answer) => {
		const { sessionId, entryAgentId, pendingQuestions } = get()
		const pendingQuestion = pendingQuestions.find((q) => q.questionId === questionId)
		if (!sessionId || !entryAgentId || !pendingQuestion) return

		// Set submitting status
		const newStatus = new Map(get().questionSubmitStatus)
		newStatus.set(questionId, 'submitting')
		set({ questionSubmitStatus: newStatus })

		// Send via REST API
		try {
			unwrap(await api.call('user-chat.answerQuestion', { sessionId, agentId: AgentId(entryAgentId), questionId: ChatMessageId(questionId), answer }))

			// Remove from pending questions and mark as answered
			set({
				pendingQuestions: get().pendingQuestions.filter((q) => q.questionId !== questionId),
				messages: get().messages.map((m) =>
					m.type === 'ask_user' && m.questionId === questionId
						? { ...m, answered: true, answer }
						: m
				),
				questionSubmitStatus: (() => {
					const s = new Map(get().questionSubmitStatus)
					s.set(questionId, 'success')
					return s
				})(),
			})

			// Clear draft answer
			const newDrafts = new Map(get().draftAnswers)
			newDrafts.delete(questionId)
			set({ draftAnswers: newDrafts })
		} catch (error) {
			console.error('Failed to answer question:', error)
			const errorStatus = new Map(get().questionSubmitStatus)
			errorStatus.set(questionId, 'error')
			set({
				questionSubmitStatus: errorStatus,
				error: error instanceof Error ? error.message : 'Failed to answer question',
			})
		}
	},

	setDraftAnswer: (questionId, answer) => {
		const newDrafts = new Map(get().draftAnswers)
		newDrafts.set(questionId, answer)
		set({ draftAnswers: newDrafts })
	},

	submitAllAnswers: async () => {
		const { sessionId, entryAgentId, pendingQuestions, draftAnswers } = get()
		if (!sessionId || !entryAgentId) return

		const toSubmit = pendingQuestions
			.map((q) => ({ question: q, answer: draftAnswers.get(q.questionId) }))
			.filter((entry): entry is { question: PendingQuestion; answer: unknown } => entry.answer !== undefined)
		if (toSubmit.length === 0) return

		const submittingStatus = new Map(get().questionSubmitStatus)
		for (const { question } of toSubmit) {
			submittingStatus.set(question.questionId, 'submitting')
		}
		set({ questionSubmitStatus: submittingStatus })

		const agentId = AgentId(entryAgentId)
		const result = await api.batch((b) =>
			toSubmit.map(({ question, answer }) =>
				b.add('user-chat.answerQuestion', {
					sessionId,
					agentId,
					questionId: ChatMessageId(question.questionId),
					answer,
				}),
			),
		)

		if (!result.ok) {
			console.error('Failed to submit answers:', result.error)
			const errorStatus = new Map(get().questionSubmitStatus)
			for (const { question } of toSubmit) {
				errorStatus.set(question.questionId, 'error')
			}
			set({
				questionSubmitStatus: errorStatus,
				error: result.error.message,
			})
			return
		}

		const submittedIds = new Set(toSubmit.map(({ question }) => question.questionId))
		const submittedAnswers = new Map(toSubmit.map(({ question, answer }) => [question.questionId, answer]))
		const successStatus = new Map(get().questionSubmitStatus)
		for (const id of submittedIds) {
			successStatus.set(id, 'success')
		}
		const newDrafts = new Map(get().draftAnswers)
		for (const id of submittedIds) {
			newDrafts.delete(id)
		}
		set({
			pendingQuestions: get().pendingQuestions.filter((q) => !submittedIds.has(q.questionId)),
			messages: get().messages.map((m) =>
				m.type === 'ask_user' && submittedIds.has(m.questionId)
					? { ...m, answered: true, answer: submittedAnswers.get(m.questionId) }
					: m,
			),
			questionSubmitStatus: successStatus,
			draftAnswers: newDrafts,
		})
	},

	setMessageContext: (context) => {
		set({ messageContext: context })
	},

	clearSession: () => {
		// Disconnect WebSocket (session was tied to the connection URL)
		useConnectionStore.getState().disconnect()

		// Clear project ID from RPC client
		configureProjectId(null)

		set({
			sessionId: null,
			projectId: null,
			presetId: null,
			entryAgentId: null,
			status: 'idle',
			messages: [],
			pendingQuestions: [],
			draftAnswers: new Map(),
			questionSubmitStatus: new Map(),
			isAgentTyping: false,
			isAgentConnected: false,
			error: null,
			pendingMessages: new Map(),
			pendingAttachments: new Map(),
			messageContext: null,
			services: new Map(),
			initStatus: 'connecting',
			initSteps: [],
		})
	},

	fetchServiceUrl: (_instanceId, sessionId, serviceType) => {
		// Fire-and-forget: call platform instance RPC to get/start service.
		// Goes through `instanceApi` so the bearer token configured by `useChat`
		// is attached — raw fetch would land at the instance route without a
		// credential and 401.
		instanceApi.call('getServiceUrl', { sessionId, serviceType })
			.then(result => {
				if (!result.ok || !result.value.url) return
				const newServices = new Map(get().services)
				newServices.set(serviceType, { serviceType, status: 'ready', code: result.value.url })
				set({ services: newServices })
			})
			.catch(() => {/* ignore — service will appear via WS when ready */})
	},

	fetchAllServiceUrls: (sessionId) => {
		// Bulk fetch all service URLs — does not depend on WS notification.
		instanceApi.call('getServiceUrls', { sessionId })
			.then(result => {
				if (!result.ok) return
				const newServices = new Map(get().services)
				for (const svc of result.value.services) {
					newServices.set(svc.serviceType, {
						serviceType: svc.serviceType,
						status: 'ready',
						code: svc.code,
						port: svc.port,
					})
				}
				set({ services: newServices })
			})
			.catch(() => {/* ignore */})
	},

	updateSessionState: async (updates) => {
		const { sessionId } = get()
		if (!sessionId) return
		const result = await api.call('sessionState.update', { sessionId, updates })
		if (result.ok && typeof result.value === 'object' && result.value !== null && 'state' in result.value) {
			set({ sessionState: (result.value as { state: Record<string, unknown> }).state })
		}
	},

	handleServerMessage: (type, payload) => {
		const { sessionId } = get()

		// Ignore messages for other sessions
		if (typeof payload === 'object' && payload !== null && 'sessionId' in payload) {
			const msgSessionId = (payload as { sessionId: unknown }).sessionId
			if (msgSessionId !== sessionId) {
				return
			}
		}

		switch (type) {
			case 'agentMessage': {
				if (typeof payload !== 'object' || payload === null) return
				const p = payload as Record<string, unknown>
				if (typeof p.content !== 'string' || typeof p.timestamp !== 'number') return
				set({
					messages: [
						...get().messages,
						{
							type: 'agent_message',
							messageId: ChatMessageId(crypto.randomUUID()),
							content: p.content,
							format: typeof p.format === 'string' ? (p.format as 'text' | 'markdown') : 'text',
							timestamp: p.timestamp,
						},
					],
					isAgentTyping: false,
				})
				break
			}

			case 'askUser': {
				if (typeof payload !== 'object' || payload === null) return
				const p = payload as Record<string, unknown>
				if (typeof p.questionId !== 'string' || typeof p.question !== 'string' || typeof p.timestamp !== 'number') return
				set({
					messages: [
						...get().messages,
						{
							type: 'ask_user',
							questionId: ChatMessageId(p.questionId),
							question: p.question,
							inputType: p.inputType as AskUserInputType,
							answered: false,
							timestamp: p.timestamp,
						},
					],
					pendingQuestions: [
						...get().pendingQuestions,
						{
							questionId: p.questionId,
							question: p.question,
							inputType: p.inputType as AskUserInputType,
							timestamp: p.timestamp,
						},
					],
					isAgentTyping: false,
				})
				break
			}

			case 'agentStatus': {
				if (typeof payload !== 'object' || payload === null) return
				const p = payload as Record<string, unknown>
				set({
					isAgentTyping: p.status === 'thinking',
				})
				break
			}

			case 'error': {
				if (typeof payload !== 'object' || payload === null) return
				const p = payload as Record<string, unknown>
				if (typeof p.message === 'string') {
					set({ error: p.message })
				}
				break
			}

			case 'initProgress': {
				if (typeof payload !== 'object' || payload === null) return
				const p = payload as Record<string, unknown>
				const step = typeof p.step === 'string' ? p.step : null
				if (!step) return

				const newStatus = step === 'ready' ? 'ready' as const
					: step === 'failed' ? 'failed' as const
						: 'initializing' as const

				set({
					initStatus: newStatus,
					initSteps: [
						...get().initSteps,
						{
							step,
							detail: typeof p.detail === 'string' ? p.detail : undefined,
							timestamp: Date.now(),
						},
					],
				})

				// When init completes, reload session data from agent
				// (initial loadSession may have received stub responses while session was pending)
				if (newStatus === 'ready') {
					const { sessionId } = get()
					if (sessionId) {
						api.call('sessions.get', { sessionId }).then(result => {
							if (!result.ok) return
							set({ entryAgentId: result.value.entryAgentId, isAgentConnected: result.value.agentCount > 0 })
						}).catch(() => {})
						api.call('user-chat.getMessages', { sessionId }).then(result => {
							if (!result.ok) return
							const messages = result.value.messages.filter(isChatMessage)
							if (messages.length > 0) {
								set({ messages })
							}
						}).catch(() => {})
					}
				}

				break
			}

			case 'agentEvent': {
				if (typeof payload !== 'object' || payload === null) return
				const p = payload as Record<string, unknown>
				const event = p.event as Record<string, unknown> | undefined
				if (event?.eventType === 'agent_connected') {
					set({
						isAgentConnected: true,
						...(get().initStatus !== 'ready' ? { initStatus: 'ready' as const } : {}),
					})
				} else if (event?.eventType === 'agent_disconnected') {
					set({ isAgentConnected: false })
				}
				break
			}

			case 'serviceStatus': {
				if (typeof payload !== 'object' || payload === null) return
				const p = payload as Record<string, unknown>
				const serviceType = typeof p.serviceType === 'string' ? p.serviceType : null
				if (!serviceType) return

				const newServices = new Map(get().services)
				const status = typeof p.status === 'string' ? p.status : 'unknown'
				if (status === 'ready') {
					newServices.set(serviceType, {
						serviceType,
						status,
						port: typeof p.port === 'number' ? p.port : undefined,
						code: typeof p.code === 'string' ? p.code : undefined,
					})
				} else {
					newServices.delete(serviceType)
				}
				set({ services: newServices })
				break
			}

			case 'sessionStateChanged': {
				if (typeof payload !== 'object' || payload === null) return
				const p = payload as Record<string, unknown>
				if (typeof p.state === 'object' && p.state !== null) {
					set({ sessionState: p.state as Record<string, unknown> })
				}
				break
			}
		}
	},
}))

/**
 * Hook for setting up message handler to forward server messages to session store.
 * Also re-fetches service URLs on WebSocket reconnect and browser tab visibility change.
 */
export function useSessionMessageHandler(): void {
	const handleServerMessage = useSessionStore((s) => s.handleServerMessage)
	const addHandler = useConnectionStore((s) => s.addMessageHandler)
	const removeHandler = useConnectionStore((s) => s.removeMessageHandler)

	useEffect(() => {
		const handlerId = 'session-store'
		addHandler(handlerId, handleServerMessage)
		return () => removeHandler(handlerId)
	}, [handleServerMessage, addHandler, removeHandler])

	// Re-fetch services on WS reconnect
	useEffect(() => {
		return useConnectionStore.subscribe(
			(s) => s.status,
			(status, prevStatus) => {
				if (status === 'connected' && prevStatus === 'reconnecting') {
					const { sessionId, fetchAllServiceUrls } = useSessionStore.getState()
					if (sessionId) {
						fetchAllServiceUrls(sessionId)
						// Refetch session state
						api.call('sessionState.get', { sessionId })
							.then(result => {
								if (result.ok && typeof result.value === 'object' && result.value !== null && 'state' in result.value) {
									useSessionStore.setState({ sessionState: (result.value as { state: Record<string, unknown> }).state })
								}
							})
							.catch(() => {})
					}
				}
			},
		)
	}, [])

	// Re-fetch services when browser tab becomes visible again
	useEffect(() => {
		const handleVisibilityChange = () => {
			if (document.hidden) return
			const { sessionId, fetchAllServiceUrls } = useSessionStore.getState()
			const { status } = useConnectionStore.getState()
			if (sessionId && status === 'connected') {
				fetchAllServiceUrls(sessionId)
			}
		}
		document.addEventListener('visibilitychange', handleVisibilityChange)
		return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
	}, [])
}
