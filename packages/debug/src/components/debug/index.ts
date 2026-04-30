/**
 * Debug Components Index
 *
 * Re-exports all debug-related components for external use.
 */

// Context (host app must provide this)
export { DebugContext, useDebugContext, type DebugContextValue } from './DebugContext.js'

// Navigation utilities
export { DebugLink, useDebugNavigate, useDebugParams, useDebugSessionId } from './DebugNavigation.js'

// Shell (layout without router dependency)
export { BackIcon, DebugShell, getNavItemClassName, navItems, type NavItem } from './DebugShell.js'

// Detail components
export { LLMCallDetail } from './LLMCallDetail.js'

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
} from './pages/index.js'

// Communication diagram components
export { CommunicationDiagram } from './communication/CommunicationDiagram.js'
