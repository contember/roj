/**
 * @roj-ai/debug
 *
 * React debug UI for session event inspection — extracted from @roj-ai/client.
 */

// Event store
export {
	selectAgentTree,
	selectGlobalMailbox,
	selectMetrics,
	selectTimeline,
	useAgentDetail,
	useAgentTree,
	useChatDebug,
	useEvents,
	useEventStore,
	useGlobalMailbox,
	useMetrics,
	useSessionInfo,
	useTimeline,
} from './stores/event-store.js'

// Event polling provider
export { EventPollingProvider, useEventPolling } from './providers/EventPollingProvider.js'

// Debug components (context, navigation, shell, pages, diagrams)
export {
	AgentDetailPage,
	AgentsPage,
	BackIcon,
	CommunicationDiagram,
	CommunicationPage,
	DashboardPage,
	DebugContext,
	DebugLink,
	DebugShell,
	EventsPage,
	FilesPage,
	getNavItemClassName,
	LLMCallDetail,
	LLMCallPage,
	LLMCallsPage,
	LogsPage,
	MailboxPage,
	navItems,
	ServicesPage,
	TimelinePage,
	useDebugContext,
	useDebugNavigate,
	useDebugParams,
	useDebugSessionId,
	UserChatPage,
} from './components/debug/index.js'
export type { DebugContextValue, NavItem } from './components/debug/index.js'
