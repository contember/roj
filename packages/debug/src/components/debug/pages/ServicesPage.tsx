import { useCallback, useState } from 'react'
import type { ServiceEntry, ServiceStatus } from '@roj-ai/shared'
import { api } from '@roj-ai/client'
import { useDebugSessionId } from '../DebugNavigation.js'
import { useEventStore } from '../../../stores/event-store.js'

const statusColors: Record<ServiceStatus, string> = {
	stopped: 'bg-slate-100 text-slate-700',
	starting: 'bg-yellow-100 text-yellow-700',
	ready: 'bg-green-100 text-green-700',
	stopping: 'bg-orange-100 text-orange-700',
	failed: 'bg-red-100 text-red-700',
	paused: 'bg-blue-100 text-blue-700',
}

function formatTimestamp(ts: number | undefined): string {
	if (ts === undefined) return '-'
	return new Date(ts).toLocaleTimeString()
}

export function ServicesPage() {
	const sessionId = useDebugSessionId()
	const services = useEventStore((s) => s.servicesProjectionState.services)

	if (!sessionId) return null

	if (services.size === 0) {
		return (
			<div className="bg-white rounded-md border border-slate-200 p-8 text-center text-slate-500 text-sm">
				No services configured
			</div>
		)
	}

	return (
		<div className="flex flex-col gap-4">
			<div className="bg-white rounded-md border border-slate-200 overflow-hidden">
				<table className="w-full text-sm">
					<thead>
						<tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
							<th className="px-4 py-3">Service</th>
							<th className="px-4 py-3">Status</th>
							<th className="px-4 py-3">Port</th>
							<th className="px-4 py-3">Started</th>
							<th className="px-4 py-3">Ready</th>
							<th className="px-4 py-3">Stopped</th>
							<th className="px-4 py-3">Error</th>
							<th className="px-4 py-3">Actions</th>
						</tr>
					</thead>
					<tbody className="divide-y divide-slate-100">
						{[...services.entries()].map(([key, entry]) => (
							<ServiceRow key={key} entry={entry} sessionId={sessionId} />
						))}
					</tbody>
				</table>
			</div>
		</div>
	)
}

function ServiceRow({ entry, sessionId }: { entry: ServiceEntry; sessionId: string }) {
	const [loading, setLoading] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [logs, setLogs] = useState<string[] | null>(null)

	const callAction = useCallback(async (action: 'start' | 'stop' | 'restart') => {
		setLoading(action)
		setError(null)
		try {
			const result = action === 'start'
				? await api.call('services.start', { sessionId, serviceType: entry.serviceType })
				: action === 'stop'
					? await api.call('services.stop', { sessionId, serviceType: entry.serviceType })
					: await api.call('services.restart', { sessionId, serviceType: entry.serviceType })

			if (!result.ok) {
				setError(result.error.message)
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Unknown error')
		} finally {
			setLoading(null)
		}
	}, [sessionId, entry.serviceType])

	const fetchLogs = useCallback(async () => {
		if (logs !== null) {
			setLogs(null)
			return
		}
		setLoading('logs')
		setError(null)
		try {
			const result = await api.call('services.logs', { sessionId, serviceType: entry.serviceType, lines: 100 })
			if (result.ok) {
				setLogs(result.value.lines)
			} else {
				setError(result.error.message)
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Unknown error')
		} finally {
			setLoading(null)
		}
	}, [sessionId, entry.serviceType, logs])

	const isRunning = entry.status === 'ready' || entry.status === 'starting'
	const isStopped = entry.status === 'stopped' || entry.status === 'failed'

	return (
		<>
			<tr className="hover:bg-slate-50 transition-colors">
				<td className="px-4 py-3 font-mono font-medium text-slate-900">{entry.serviceType}</td>
				<td className="px-4 py-3">
					<span className={`inline-block text-xs px-2 py-0.5 rounded-full font-medium ${statusColors[entry.status]}`}>
						{entry.status}
					</span>
				</td>
				<td className="px-4 py-3 font-mono text-slate-600">{entry.port ?? '-'}</td>
				<td className="px-4 py-3 text-slate-500">{formatTimestamp(entry.startedAt)}</td>
				<td className="px-4 py-3 text-slate-500">{formatTimestamp(entry.readyAt)}</td>
				<td className="px-4 py-3 text-slate-500">{formatTimestamp(entry.stoppedAt)}</td>
				<td className="px-4 py-3 text-red-600 text-xs">{entry.error ?? '-'}</td>
				<td className="px-4 py-3">
					<div className="flex items-center gap-1.5">
						{isStopped && (
							<ActionButton onClick={() => callAction('start')} loading={loading === 'start'} color="green">
								Start
							</ActionButton>
						)}
						{isRunning && (
							<ActionButton onClick={() => callAction('stop')} loading={loading === 'stop'} color="red">
								Stop
							</ActionButton>
						)}
						{isRunning && (
							<ActionButton onClick={() => callAction('restart')} loading={loading === 'restart'} color="yellow">
								Restart
							</ActionButton>
						)}
						<ActionButton onClick={fetchLogs} loading={loading === 'logs'} color="slate" active={logs !== null}>
							Logs
						</ActionButton>
					</div>
					{error && <div className="mt-1 text-xs text-red-600">{error}</div>}
				</td>
			</tr>
			{logs !== null && (
				<tr>
					<td colSpan={8} className="px-4 py-2 bg-slate-900">
						<div className="max-h-80 overflow-auto font-mono text-xs text-slate-300 whitespace-pre-wrap">
							{logs.length === 0
								? <span className="text-slate-500">No logs available</span>
								: logs.join('\n')}
						</div>
					</td>
				</tr>
			)}
		</>
	)
}

const buttonColors = {
	green: 'bg-green-50 text-green-700 hover:bg-green-100 border-green-200',
	red: 'bg-red-50 text-red-700 hover:bg-red-100 border-red-200',
	yellow: 'bg-yellow-50 text-yellow-700 hover:bg-yellow-100 border-yellow-200',
	slate: 'bg-slate-50 text-slate-700 hover:bg-slate-100 border-slate-200',
}

function ActionButton({
	onClick,
	loading,
	color,
	active,
	children,
}: {
	onClick: () => void
	loading: boolean
	color: keyof typeof buttonColors
	active?: boolean
	children: React.ReactNode
}) {
	return (
		<button
			onClick={onClick}
			disabled={loading}
			className={`px-2 py-1 text-xs font-medium rounded border transition-colors disabled:opacity-50 ${active ? 'ring-1 ring-offset-1 ring-slate-400' : ''} ${buttonColors[color]}`}
		>
			{loading ? '...' : children}
		</button>
	)
}
