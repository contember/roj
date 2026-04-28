import type { AgentId, ProjectionEvent } from '@roj-ai/shared'
import type { DomainEvent } from '@roj-ai/sdk'
import {
	type AgentDetailProjectionState,
	type AgentRegistryState,
	type AgentTreeNode,
	type AgentTreeProjectionState,
	type ChatDebugState,
	type DebugChatMessage,
	type GetAgentDetailResponse,
	type GetMetricsResponse,
	type GlobalMailboxMessage,
	type MailboxState,
	type MetricsState,
	type ServicesProjectionState,
	type SessionInfoState,
	type TimelineItem,
	type TimelineState,
	applyEventToAgentDetail,
	applyEventToAgentRegistry,
	applyEventToAgentTree,
	applyEventToChatDebug,
	applyEventToMailbox,
	applyEventToMetrics,
	applyEventToServices,
	applyEventToSessionInfo,
	applyEventToTimeline,
	buildAgentTreeFromProjection,
	createAgentDetailProjectionState,
	createAgentRegistryState,
	createAgentTreeProjectionState,
	createChatDebugState,
	createMailboxState,
	createMetricsState,
	createServicesProjectionState,
	createSessionInfoState,
	createTimelineState,
	getAgentDetail,
	getChatDebugMessages,
	getMailboxMessages,
	getTimelineItems,
	isDomainEvent,
	metricsStateToResponse,
} from '@roj-ai/shared'
import { useMemo } from 'react'
import { create } from 'zustand'
import { api, unwrap } from '@roj-ai/client'

/**
 * Event store for managing session events and derived state.
 *
 * This store:
 * - Loads and polls for events from the server
 * - Applies events incrementally to projection states (no SessionState needed)
 * - Provides selectors for derived data (agent tree, timeline, mailbox, metrics)
 *
 * All projections are computed incrementally - adding a new event only updates
 * the affected projection state, not rebuilds from scratch.
 */
interface EventStoreState {
	// Core state
	sessionId: string | null
	events: DomainEvent[]
	lastIndex: number
	isLoading: boolean
	error: string | null

	// Projection states (incremental reducers - internal)
	sessionInfoState: SessionInfoState
	agentRegistryState: AgentRegistryState
	agentTreeProjectionState: AgentTreeProjectionState
	agentDetailProjectionState: AgentDetailProjectionState
	servicesProjectionState: ServicesProjectionState
	metricsState: MetricsState
	timelineState: TimelineState
	mailboxState: MailboxState
	chatDebugState: ChatDebugState

	// Derived data (cached, updated when events change)
	metrics: GetMetricsResponse
	timeline: TimelineItem[]
	agentTree: AgentTreeNode[]
	globalMailbox: GlobalMailboxMessage[]
	chatDebugMessages: DebugChatMessage[]

	// Polling state
	isPolling: boolean
	pollIntervalMs: number

	// Actions
	loadSession: (sessionId: string) => Promise<void>
	fetchNewEvents: () => Promise<void>
	reset: () => void
	startPolling: () => void
	stopPolling: () => void
}

// Polling interval reference (stored outside Zustand for cleanup)
let pollingIntervalId: ReturnType<typeof setInterval> | null = null

// Counter to track which loadSession call is current (for cancellation)
let loadSessionCounter = 0

// Default empty metrics
const emptyMetrics: GetMetricsResponse = {
	totalTokens: 0,
	promptTokens: 0,
	completionTokens: 0,
	llmCalls: 0,
	toolCalls: 0,
	agentCount: 0,
	totalCost: 0,
	durationMs: 0,
	byProvider: {},
}

interface ProjectionStates {
	sessionInfoState: SessionInfoState
	agentRegistryState: AgentRegistryState
	agentTreeProjectionState: AgentTreeProjectionState
	agentDetailProjectionState: AgentDetailProjectionState
	servicesProjectionState: ServicesProjectionState
	metricsState: MetricsState
	timelineState: TimelineState
	mailboxState: MailboxState
	chatDebugState: ChatDebugState
}

function createInitialProjections(): ProjectionStates {
	return {
		sessionInfoState: createSessionInfoState(),
		agentRegistryState: createAgentRegistryState(),
		agentTreeProjectionState: createAgentTreeProjectionState(),
		agentDetailProjectionState: createAgentDetailProjectionState(),
		servicesProjectionState: createServicesProjectionState(),
		metricsState: createMetricsState(),
		timelineState: createTimelineState(),
		mailboxState: createMailboxState(),
		chatDebugState: createChatDebugState(),
	}
}

/**
 * Compute all derived data from projection states.
 */
function computeDerivedData(projections: ProjectionStates): {
	metrics: GetMetricsResponse
	timeline: TimelineItem[]
	agentTree: AgentTreeNode[]
	globalMailbox: GlobalMailboxMessage[]
	chatDebugMessages: DebugChatMessage[]
} {
	return {
		metrics: metricsStateToResponse(projections.metricsState, projections.agentRegistryState.count),
		timeline: getTimelineItems(projections.timelineState, projections.agentRegistryState),
		agentTree: buildAgentTreeFromProjection(projections.agentTreeProjectionState),
		globalMailbox: getMailboxMessages(projections.mailboxState),
		chatDebugMessages: getChatDebugMessages(projections.chatDebugState),
	}
}

/**
 * Apply a single event to all projection states.
 * Does NOT compute derived data - call computeDerivedData separately at the end.
 */
function applyEventToProjections(projections: ProjectionStates, event: DomainEvent): ProjectionStates {
	const e = event as ProjectionEvent
	// Update registry first (other projections may need agent names)
	const agentRegistryState = applyEventToAgentRegistry(projections.agentRegistryState, e)

	return {
		sessionInfoState: applyEventToSessionInfo(projections.sessionInfoState, e),
		agentRegistryState,
		agentTreeProjectionState: applyEventToAgentTree(projections.agentTreeProjectionState, e),
		agentDetailProjectionState: applyEventToAgentDetail(projections.agentDetailProjectionState, e),
		servicesProjectionState: applyEventToServices(projections.servicesProjectionState, e),
		metricsState: applyEventToMetrics(projections.metricsState, e),
		timelineState: applyEventToTimeline(projections.timelineState, e, agentRegistryState),
		mailboxState: applyEventToMailbox(projections.mailboxState, e, agentRegistryState),
		chatDebugState: applyEventToChatDebug(projections.chatDebugState, e, agentRegistryState),
	}
}

export const useEventStore = create<EventStoreState>((set, get) => ({
	sessionId: null,
	events: [],
	lastIndex: -1,
	...createInitialProjections(),
	// Derived data (cached)
	metrics: emptyMetrics,
	timeline: [],
	agentTree: [],
	globalMailbox: [],
	chatDebugMessages: [],
	isLoading: false,
	error: null,
	isPolling: false,
	pollIntervalMs: 2000,

	loadSession: async (sessionId: string) => {
		// Stop any existing polling
		get().stopPolling()

		// Increment counter to invalidate any in-flight loadSession calls
		const thisLoadId = ++loadSessionCounter

		set({
			sessionId,
			events: [],
			lastIndex: -1,
			...createInitialProjections(),
			metrics: emptyMetrics,
			timeline: [],
			agentTree: [],
			globalMailbox: [],
			chatDebugMessages: [],
			isLoading: true,
			error: null,
		})

		try {
			// Load all events for the session
			const response = unwrap(await api.call('sessions.getEvents', { sessionId, limit: 10000 }))

			// Check if this load was superseded by a newer one
			if (loadSessionCounter !== thisLoadId) {
				return
			}

			// Validate unknown[] to DomainEvent[]
			const validEvents = response.events.filter(isDomainEvent)

			if (validEvents.length === 0) {
				set({
					isLoading: false,
					lastIndex: response.lastIndex,
				})
				return
			}

			// First event should be session_created
			const firstEvent = validEvents[0]
			const e = firstEvent as ProjectionEvent
			if (e.type !== 'session_created') {
				throw new Error('First event must be session_created')
			}

			// Apply all events to projections
			let projections = createInitialProjections()
			for (const event of validEvents) {
				projections = applyEventToProjections(projections, event)
			}

			// Compute derived data once at the end
			const derived = computeDerivedData(projections)

			set({
				events: validEvents,
				lastIndex: response.lastIndex,
				...projections,
				...derived,
				isLoading: false,
			})

			// Start polling for new events
			get().startPolling()
		} catch (err) {
			set({
				isLoading: false,
				error: err instanceof Error ? err.message : 'Failed to load session events',
			})
		}
	},

	fetchNewEvents: async () => {
		const { sessionId, lastIndex } = get()
		if (!sessionId) return

		try {
			// Fetch events since last index
			const response = unwrap(await api.call('sessions.getEvents', {
				sessionId,
				since: lastIndex,
				limit: 1000,
			}))

			// Check if session was reset/changed while we were fetching
			const currentState = get()
			if (currentState.sessionId !== sessionId) {
				return
			}

			// Validate unknown[] to DomainEvent[]
			const newEvents = response.events.filter(isDomainEvent)

			if (newEvents.length === 0) {
				// No new events, just update lastIndex in case it changed
				if (response.lastIndex !== lastIndex) {
					set({ lastIndex: response.lastIndex })
				}
				return
			}

			// Get current projection states
			const { events } = get()
			let projections: ProjectionStates = {
				sessionInfoState: currentState.sessionInfoState,
				agentRegistryState: currentState.agentRegistryState,
				agentTreeProjectionState: currentState.agentTreeProjectionState,
				agentDetailProjectionState: currentState.agentDetailProjectionState,
				servicesProjectionState: currentState.servicesProjectionState,
				metricsState: currentState.metricsState,
				timelineState: currentState.timelineState,
				mailboxState: currentState.mailboxState,
				chatDebugState: currentState.chatDebugState,
			}

			// If we don't have any agents yet, check if first event is session_created
			if (projections.agentRegistryState.count === 0 && events.length === 0) {
				const allEvents = [...events, ...newEvents]
				const firstEvent = allEvents[0]
				if (!firstEvent || firstEvent.type !== 'session_created') {
					// Wait for session_created event
					set({ lastIndex: response.lastIndex })
					return
				}

				// Initialize from scratch
				projections = createInitialProjections()
				for (const event of allEvents) {
					projections = applyEventToProjections(projections, event)
				}

				const derived = computeDerivedData(projections)
				set({
					events: allEvents,
					lastIndex: response.lastIndex,
					...projections,
					...derived,
					error: null,
				})
				return
			}

			// Apply only new events incrementally
			for (const event of newEvents) {
				projections = applyEventToProjections(projections, event)
			}

			const derived = computeDerivedData(projections)
			set({
				events: [...events, ...newEvents],
				lastIndex: response.lastIndex,
				...projections,
				...derived,
				error: null,
			})
		} catch (err) {
			// Don't set error on poll failures to avoid UI flicker
			console.error('Failed to fetch new events:', err)
		}
	},

	reset: () => {
		get().stopPolling()
		// Invalidate any in-flight loadSession calls
		loadSessionCounter++
		set({
			sessionId: null,
			events: [],
			lastIndex: -1,
			...createInitialProjections(),
			metrics: emptyMetrics,
			timeline: [],
			agentTree: [],
			globalMailbox: [],
			chatDebugMessages: [],
			isLoading: false,
			error: null,
		})
	},

	startPolling: () => {
		if (pollingIntervalId) {
			clearInterval(pollingIntervalId)
		}

		const { pollIntervalMs, fetchNewEvents } = get()
		pollingIntervalId = setInterval(fetchNewEvents, pollIntervalMs)
		set({ isPolling: true })
	},

	stopPolling: () => {
		if (pollingIntervalId) {
			clearInterval(pollingIntervalId)
			pollingIntervalId = null
		}
		set({ isPolling: false })
	},
}))

// ============================================================================
// Selectors - return cached data from store
// ============================================================================

/**
 * Get agent tree (cached in store).
 */
export function selectAgentTree(state: EventStoreState): AgentTreeNode[] {
	return state.agentTree
}

/**
 * Get timeline items (cached in store).
 */
export function selectTimeline(state: EventStoreState): TimelineItem[] {
	return state.timeline
}

/**
 * Get global mailbox messages (cached in store).
 */
export function selectGlobalMailbox(state: EventStoreState): GlobalMailboxMessage[] {
	return state.globalMailbox
}

/**
 * Get metrics (cached in store).
 */
export function selectMetrics(state: EventStoreState): GetMetricsResponse {
	return state.metrics
}

// ============================================================================
// React hooks for derived data
// ============================================================================

/**
 * Hook to get agent tree (cached in store).
 */
export function useAgentTree(): AgentTreeNode[] {
	return useEventStore((s) => s.agentTree)
}

/**
 * Hook to get timeline items (cached in store).
 */
export function useTimeline(): TimelineItem[] {
	return useEventStore((s) => s.timeline)
}

/**
 * Hook to get global mailbox messages (cached in store).
 */
export function useGlobalMailbox(): GlobalMailboxMessage[] {
	return useEventStore((s) => s.globalMailbox)
}

/**
 * Hook to get metrics (cached in store).
 */
export function useMetrics(): GetMetricsResponse {
	return useEventStore((s) => s.metrics)
}

/**
 * Hook to get raw events.
 */
export function useEvents(): DomainEvent[] {
	return useEventStore((s) => s.events)
}

/**
 * Hook to get chat debug messages (cached in store).
 */
export function useChatDebug(): DebugChatMessage[] {
	return useEventStore((s) => s.chatDebugMessages)
}

/**
 * Hook to get session info (metadata from session lifecycle events).
 */
export function useSessionInfo(): SessionInfoState {
	return useEventStore((s) => s.sessionInfoState)
}

/**
 * Hook to get agent detail by ID.
 * Uses useMemo to avoid creating new objects on every render.
 */
export function useAgentDetail(agentId: AgentId): GetAgentDetailResponse | null {
	const agentDetailProjectionState = useEventStore((s) => s.agentDetailProjectionState)

	return useMemo(() => {
		return getAgentDetail(agentDetailProjectionState, agentId)
	}, [agentDetailProjectionState, agentId])
}
