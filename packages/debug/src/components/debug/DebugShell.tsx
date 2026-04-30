import { type ReactNode, useState } from 'react'
import { api, unwrap } from '@roj-ai/client'
import { useEventPolling } from '../../providers/EventPollingProvider.js'
import { useEventStore, useMetrics } from '../../stores/event-store.js'

export interface NavItem {
	to: string
	label: string
	icon: React.FC
}

export const navItems: NavItem[] = [
	{ to: 'dashboard', label: 'Dashboard', icon: DashboardIcon },
	{ to: 'agents', label: 'Agents', icon: AgentsIcon },
	{ to: 'communication', label: 'Communication', icon: CommunicationIcon },
	{ to: 'user-chat', label: 'User Chat', icon: UserChatIcon },
	{ to: 'timeline', label: 'Timeline', icon: TimelineIcon },
	{ to: 'llm-calls', label: 'LLM Calls', icon: LLMIcon },
	{ to: 'events', label: 'Events', icon: EventsIcon },
	{ to: 'mailbox', label: 'Mailbox', icon: MailboxIcon },
	{ to: 'files', label: 'Files', icon: FilesIcon },
	{ to: 'services', label: 'Services', icon: ServicesIcon },
	{ to: 'logs', label: 'Logs', icon: LogsIcon },
]

interface DebugShellProps {
	sessionId: string
	children: ReactNode
	className?: string
	renderNavItem: (item: NavItem) => ReactNode
	sidebarFooter?: ReactNode
}

export function DebugShell({ sessionId, children, className = 'fixed inset-0 flex flex-col', renderNavItem, sidebarFooter }: DebugShellProps) {
	const { isLoading } = useEventPolling(sessionId)
	const metrics = useMetrics()
	const hasEvents = useEventStore((s) => s.events.length > 0)

	return (
		<div className={`${className} bg-surface`}>
			{/* Header */}
			<header className="h-14 bg-white shadow-card flex items-center px-5 shrink-0 z-10">
				<div className="flex items-center gap-3">
					<span className="bg-accent-lime rounded-full px-4 py-1.5 text-sm font-bold text-gray-900">
						Roj
					</span>
					<span className="text-gray-300">/</span>
					<span className="text-sm text-gray-400 font-mono">{sessionId.slice(0, 8)}</span>
					<span className="text-gray-300">/</span>
					<span className="text-sm font-semibold text-gray-700">Debug</span>
				</div>

				{/* Metrics in header */}
				<div className="ml-auto flex items-center gap-5 text-sm">
					{hasEvents && (
						<>
							{isLoading && <span className="text-gray-400 text-xs animate-pulse">Loading...</span>}
							<MetricBadge label="Tokens" value={metrics.totalTokens.toLocaleString()} />
							<MetricBadge label="LLM" value={metrics.llmCalls.toString()} />
							<MetricBadge label="Tools" value={metrics.toolCalls.toString()} />
							<MetricBadge label="Agents" value={metrics.agentCount.toString()} />
							{metrics.totalCost !== undefined && metrics.totalCost > 0 && (
								<MetricBadge
									label="Cost"
									value={`$${metrics.totalCost.toFixed(4)}`}
									className="text-green-600"
								/>
							)}
						</>
					)}
					<SessionActionButton sessionId={sessionId} />
				</div>
			</header>

			<div className="flex flex-1 overflow-hidden">
				{/* Sidebar */}
				<nav className="w-52 bg-white shadow-card flex flex-col shrink-0 z-[5]">
					<div className="flex-1 py-3 px-3 space-y-0.5">
						{navItems.map((item) => renderNavItem(item))}
					</div>

					{sidebarFooter && (
						<div className="p-3 border-t border-gray-100">
							{sidebarFooter}
						</div>
					)}
				</nav>

				{/* Main content */}
				<main className="flex-1 overflow-auto p-5">
					{children}
				</main>
			</div>
		</div>
	)
}

export function getNavItemClassName(isActive: boolean) {
	return `flex items-center gap-3 px-4 py-2.5 text-sm rounded-2xl transition-colors ${
		isActive
			? 'bg-accent-lime text-gray-900 font-semibold'
			: 'text-gray-500 hover:bg-gray-100 hover:text-gray-800'
	}`
}

function SessionActionButton({ sessionId }: { sessionId: string }) {
	const [loading, setLoading] = useState(false)
	const status = useEventStore((s) => s.sessionInfoState.id ? s.sessionInfoState.status : null)

	if (!status) return null

	const handleAction = async () => {
		if (loading) return
		setLoading(true)
		try {
			if (status === 'active') {
				unwrap(await api.call('sessions.close', { sessionId }))
			} else {
				unwrap(await api.call('sessions.reopen', { sessionId }))
			}
		} catch (e) {
			console.error(`Failed to ${status === 'active' ? 'stop' : 'reopen'} session:`, e)
		} finally {
			setLoading(false)
		}
	}

	if (status === 'active') {
		return (
			<button
				onClick={handleAction}
				disabled={loading}
				className={`px-4 py-1.5 text-xs font-medium rounded-full transition-colors ${
					loading
						? 'bg-red-500 text-white cursor-wait opacity-70'
						: 'bg-gray-900 text-white hover:bg-gray-800'
				}`}
			>
				{loading ? 'Stopping...' : 'Stop Session'}
			</button>
		)
	}

	return (
		<button
			onClick={handleAction}
			disabled={loading}
			className={`px-4 py-1.5 text-xs font-medium rounded-full transition-colors ${
				loading
					? 'bg-green-500 text-white cursor-wait opacity-70'
					: 'bg-green-600 text-white hover:bg-green-500'
			}`}
		>
			{loading ? 'Reopening...' : 'Reopen Session'}
		</button>
	)
}

function MetricBadge({
	label,
	value,
	className,
}: {
	label: string
	value: string
	className?: string
}) {
	return (
		<div className="flex items-center gap-1.5">
			<span className="text-gray-400 text-xs">{label}</span>
			<span className={`font-semibold text-sm ${className || 'text-gray-700'}`}>{value}</span>
		</div>
	)
}

// Icons — thin-line, rounded endpoints, 1.5px stroke
function DashboardIcon() {
	return (
		<svg className="w-[18px] h-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={1.5}
				d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"
			/>
		</svg>
	)
}

function AgentsIcon() {
	return (
		<svg className="w-[18px] h-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={1.5}
				d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
			/>
		</svg>
	)
}

function TimelineIcon() {
	return (
		<svg className="w-[18px] h-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
		</svg>
	)
}

function LLMIcon() {
	return (
		<svg className="w-[18px] h-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={1.5}
				d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
			/>
		</svg>
	)
}

function EventsIcon() {
	return (
		<svg className="w-[18px] h-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={1.5}
				d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"
			/>
		</svg>
	)
}

function MailboxIcon() {
	return (
		<svg className="w-[18px] h-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={1.5}
				d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
			/>
		</svg>
	)
}

function FilesIcon() {
	return (
		<svg className="w-[18px] h-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={1.5}
				d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
			/>
		</svg>
	)
}

function ServicesIcon() {
	return (
		<svg className="w-[18px] h-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={1.5}
				d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01"
			/>
		</svg>
	)
}

function LogsIcon() {
	return (
		<svg className="w-[18px] h-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={1.5}
				d="M4 6h16M4 10h16M4 14h10M4 18h7"
			/>
		</svg>
	)
}

export function BackIcon() {
	return (
		<svg className="w-[18px] h-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
		</svg>
	)
}

function CommunicationIcon() {
	return (
		<svg className="w-[18px] h-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={1.5}
				d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
			/>
		</svg>
	)
}

function UserChatIcon() {
	return (
		<svg className="w-[18px] h-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={1.5}
				d="M17 8h2a2 2 0 012 2v6a2 2 0 01-2 2h-2v4l-4-4H9a1.994 1.994 0 01-1.414-.586m0 0L11 14h4a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2v4l.586-.586z"
			/>
		</svg>
	)
}
