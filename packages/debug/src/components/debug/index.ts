/**
 * Debug Components Index
 *
 * Re-exports all debug-related components for external use.
 */

// Context (host app must provide this)
export { DebugContext, useDebugContext, type DebugContextValue } from './DebugContext'

// Navigation utilities
export { DebugLink, useDebugNavigate, useDebugParams, useDebugSessionId } from './DebugNavigation'

// Shell (layout without router dependency)
export { BackIcon, DebugShell, getNavItemClassName, navItems, type NavItem } from './DebugShell'

// Detail components
export { LLMCallDetail } from './LLMCallDetail'

// Pages
export {
	AgentDetailPage,
	AgentsPage,
	CommunicationPage,
	DashboardPage,
	EventsPage,
	FilesPage,
	LLMCallPage,
	LLMCallsPage,
	LogsPage,
	MailboxPage,
	ServicesPage,
	TimelinePage,
	UserChatPage,
} from './pages'

// Communication diagram components
export { CommunicationDiagram } from './communication/CommunicationDiagram'
