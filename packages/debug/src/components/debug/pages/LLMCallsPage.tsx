import type { LLMCallLogEntry } from '@roj-ai/sdk'
import type { AgentId } from '@roj-ai/shared'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, unwrap } from '@roj-ai/client'
import { useEventStore } from '../../../stores/event-store'
import { DebugLink, useDebugSessionId } from '../DebugNavigation'

function isLLMCallLogEntry(data: unknown): data is LLMCallLogEntry {
	return typeof data === 'object' && data !== null && 'id' in data && 'status' in data && 'request' in data
}

const PAGE_SIZE = 50
const FETCH_LIMIT = 1000

type SortField = 'time' | 'duration' | 'tokens' | 'cost'
type SortDirection = 'asc' | 'desc'
type StatusFilter = 'all' | 'running' | 'success' | 'error'

export function LLMCallsPage() {
	const sessionId = useDebugSessionId()
	const [calls, setCalls] = useState<LLMCallLogEntry[]>([])
	const [total, setTotal] = useState(0)
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)

	const [offset, setOffset] = useState(0)
	const [agentFilter, setAgentFilter] = useState<string>('all')
	const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
	const [providerFilter, setProviderFilter] = useState<string>('all')
	const [modelFilter, setModelFilter] = useState<string>('all')
	const [sortField, setSortField] = useState<SortField>('time')
	const [sortDirection, setSortDirection] = useState<SortDirection>('desc')

	const agentProjection = useEventStore((s) => s.agentDetailProjectionState)
	const agentNameById = useMemo(() => {
		const map = new Map<AgentId, string>()
		for (const agent of agentProjection.agents.values()) {
			map.set(agent.id, agent.definitionName)
		}
		return map
	}, [agentProjection])

	const resolveAgentName = useCallback(
		(agentId: AgentId) => agentNameById.get(agentId) ?? agentId,
		[agentNameById],
	)

	const load = useCallback(async () => {
		if (!sessionId) return
		try {
			const data = unwrap(await api.call('llm.getCalls', {
				sessionId,
				limit: FETCH_LIMIT,
				offset: 0,
			}))
			setCalls(data.calls.filter(isLLMCallLogEntry))
			setTotal(data.total)
			setError(null)
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to load LLM calls')
		} finally {
			setLoading(false)
		}
	}, [sessionId])

	useEffect(() => {
		load()
		const interval = setInterval(load, 5000)
		return () => clearInterval(interval)
	}, [load])

	const uniqueAgents = useMemo(() => {
		const ids = new Set<AgentId>()
		for (const call of calls) ids.add(call.agentId)
		return Array.from(ids)
			.map((id) => ({ id, name: resolveAgentName(id) }))
			.sort((a, b) => a.name.localeCompare(b.name))
	}, [calls, resolveAgentName])

	const uniqueProviders = useMemo(() => {
		const set = new Set<string>()
		for (const call of calls) {
			const p = call.metrics?.provider
			if (p) set.add(p)
		}
		return Array.from(set).sort()
	}, [calls])

	const uniqueModels = useMemo(() => {
		const set = new Set<string>()
		for (const call of calls) set.add(call.request.model)
		return Array.from(set).sort()
	}, [calls])

	const filteredCalls = useMemo(() => {
		return calls.filter((call) => {
			if (agentFilter !== 'all' && call.agentId !== agentFilter) return false
			if (statusFilter !== 'all' && call.status !== statusFilter) return false
			if (providerFilter !== 'all' && (call.metrics?.provider ?? '') !== providerFilter) return false
			if (modelFilter !== 'all' && call.request.model !== modelFilter) return false
			return true
		})
	}, [calls, agentFilter, statusFilter, providerFilter, modelFilter])

	const sortedCalls = useMemo(() => {
		const sorted = [...filteredCalls]
		const direction = sortDirection === 'asc' ? 1 : -1
		sorted.sort((a, b) => {
			let aVal: number
			let bVal: number
			switch (sortField) {
				case 'time':
					aVal = a.createdAt
					bVal = b.createdAt
					break
				case 'duration':
					aVal = a.metrics?.latencyMs ?? a.durationMs ?? 0
					bVal = b.metrics?.latencyMs ?? b.durationMs ?? 0
					break
				case 'tokens':
					aVal = a.metrics?.totalTokens ?? 0
					bVal = b.metrics?.totalTokens ?? 0
					break
				case 'cost':
					aVal = a.metrics?.cost ?? 0
					bVal = b.metrics?.cost ?? 0
					break
			}
			return (aVal - bVal) * direction
		})
		return sorted
	}, [filteredCalls, sortField, sortDirection])

	const paginatedCalls = useMemo(
		() => sortedCalls.slice(offset, offset + PAGE_SIZE),
		[sortedCalls, offset],
	)

	const filteredTotal = sortedCalls.length
	const totalPages = Math.max(1, Math.ceil(filteredTotal / PAGE_SIZE))
	const currentPage = Math.floor(offset / PAGE_SIZE) + 1

	useEffect(() => {
		if (offset >= filteredTotal && offset > 0) setOffset(0)
	}, [filteredTotal, offset])

	const totalTokens = sortedCalls.reduce((sum, c) => sum + (c.metrics?.totalTokens ?? 0), 0)
	const totalCost = sortedCalls.reduce((sum, c) => sum + (c.metrics?.cost ?? 0), 0)

	const toggleSort = (field: SortField) => {
		if (sortField === field) {
			setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc')
		} else {
			setSortField(field)
			setSortDirection('desc')
		}
		setOffset(0)
	}

	const resetPagination = () => setOffset(0)

	return (
		<div className="space-y-4">
			{/* Summary */}
			<div className="flex items-center gap-6 text-sm">
				<span className="text-slate-600">
					<span className="font-medium text-slate-900">{filteredTotal}</span>
					{filteredTotal !== total && <span className="text-slate-400"> / {total}</span>} calls
				</span>
				<span className="text-slate-600">
					<span className="font-medium text-slate-900">{totalTokens.toLocaleString()}</span> tokens
				</span>
				{totalCost > 0 && (
					<span className="text-slate-600">
						<span className="font-medium text-green-600">${totalCost.toFixed(4)}</span> cost
					</span>
				)}
			</div>

			{/* Filters */}
			<div className="flex flex-wrap items-center gap-3 text-sm">
				<FilterSelect
					label='Agent'
					value={agentFilter}
					onChange={(v) => {
						setAgentFilter(v)
						resetPagination()
					}}
					options={[
						{ value: 'all', label: 'All agents' },
						...uniqueAgents.map((a) => ({ value: a.id, label: a.name })),
					]}
				/>
				<FilterSelect
					label='Status'
					value={statusFilter}
					onChange={(v) => {
						setStatusFilter(v as StatusFilter)
						resetPagination()
					}}
					options={[
						{ value: 'all', label: 'All statuses' },
						{ value: 'running', label: 'running' },
						{ value: 'success', label: 'success' },
						{ value: 'error', label: 'error' },
					]}
				/>
				<FilterSelect
					label='Provider'
					value={providerFilter}
					onChange={(v) => {
						setProviderFilter(v)
						resetPagination()
					}}
					options={[
						{ value: 'all', label: 'All providers' },
						...uniqueProviders.map((p) => ({ value: p, label: p })),
					]}
				/>
				<FilterSelect
					label='Model'
					value={modelFilter}
					onChange={(v) => {
						setModelFilter(v)
						resetPagination()
					}}
					options={[
						{ value: 'all', label: 'All models' },
						...uniqueModels.map((m) => ({ value: m, label: m })),
					]}
				/>
			</div>

			{/* Error */}
			{error && <div className="text-red-500 text-sm">{error}</div>}

			{/* Table */}
			<div className="bg-white rounded-md border border-slate-200 overflow-hidden">
				{loading && calls.length === 0
					? <div className="p-4 text-slate-500 text-sm">Loading...</div>
					: paginatedCalls.length === 0
					? <div className="p-4 text-slate-500 text-sm">No LLM calls found</div>
					: (
						<div className="overflow-x-auto">
							<table className="w-full text-sm">
								<thead className="bg-slate-50 border-b border-slate-200">
									<tr>
										<SortableHeader
											label='Time'
											field='time'
											sortField={sortField}
											sortDirection={sortDirection}
											onClick={toggleSort}
											align='left'
										/>
										<th className="px-3 py-2 text-left font-medium text-slate-600">Status</th>
										<th className="px-3 py-2 text-left font-medium text-slate-600">Provider</th>
										<th className="px-3 py-2 text-left font-medium text-slate-600">Model</th>
										<SortableHeader
											label='Duration'
											field='duration'
											sortField={sortField}
											sortDirection={sortDirection}
											onClick={toggleSort}
											align='right'
										/>
										<SortableHeader
											label='Tokens'
											field='tokens'
											sortField={sortField}
											sortDirection={sortDirection}
											onClick={toggleSort}
											align='right'
										/>
										<SortableHeader
											label='Cost'
											field='cost'
											sortField={sortField}
											sortDirection={sortDirection}
											onClick={toggleSort}
											align='right'
										/>
										<th className="px-3 py-2 text-left font-medium text-slate-600">Agent</th>
									</tr>
								</thead>
								<tbody className="divide-y divide-slate-200">
									{paginatedCalls.map((call) => (
										<CallRow
											key={call.id}
											call={call}
											agentName={resolveAgentName(call.agentId)}
										/>
									))}
								</tbody>
							</table>
						</div>
					)}
			</div>

			{/* Pagination */}
			{totalPages > 1 && (
				<div className="flex items-center justify-between">
					<button
						onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
						disabled={offset === 0}
						className="px-3 py-1 text-sm border border-slate-300 rounded hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
					>
						Previous
					</button>
					<span className="text-sm text-slate-600">
						Page {currentPage} of {totalPages}
					</span>
					<button
						onClick={() => setOffset(offset + PAGE_SIZE)}
						disabled={currentPage >= totalPages}
						className="px-3 py-1 text-sm border border-slate-300 rounded hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
					>
						Next
					</button>
				</div>
			)}
		</div>
	)
}

function FilterSelect({
	label,
	value,
	onChange,
	options,
}: {
	label: string
	value: string
	onChange: (value: string) => void
	options: { value: string; label: string }[]
}) {
	return (
		<label className="text-slate-600 flex items-center gap-2">
			<span>{label}:</span>
			<select
				value={value}
				onChange={(e) => onChange(e.target.value)}
				className="border border-slate-300 rounded px-2 py-1 text-sm bg-white"
			>
				{options.map((opt) => (
					<option key={opt.value} value={opt.value}>
						{opt.label}
					</option>
				))}
			</select>
		</label>
	)
}

function SortableHeader({
	label,
	field,
	sortField,
	sortDirection,
	onClick,
	align,
}: {
	label: string
	field: SortField
	sortField: SortField
	sortDirection: SortDirection
	onClick: (field: SortField) => void
	align: 'left' | 'right'
}) {
	const active = sortField === field
	const arrow = active ? (sortDirection === 'asc' ? '▲' : '▼') : ''
	return (
		<th className={`px-3 py-2 font-medium text-slate-600 ${align === 'right' ? 'text-right' : 'text-left'}`}>
			<button
				type='button'
				onClick={() => onClick(field)}
				className={`inline-flex items-center gap-1 hover:text-slate-900 ${active ? 'text-slate-900' : ''}`}
			>
				<span>{label}</span>
				{arrow && <span className="text-xs">{arrow}</span>}
			</button>
		</th>
	)
}

function CallRow({ call, agentName }: { call: LLMCallLogEntry; agentName: string }) {
	const metrics = call.metrics

	const promptTokens = metrics?.promptTokens ?? 0
	const completionTokens = metrics?.completionTokens ?? 0
	const totalTokens = promptTokens + completionTokens
	const cost = metrics?.cost
	const latency = metrics?.latencyMs ?? call.durationMs

	return (
		<tr className="hover:bg-slate-50">
			{/* Time */}
			<td className="px-3 py-2 font-mono text-xs text-slate-500">
				<DebugLink
					to={`llm-calls/${call.id}`}
					className="hover:text-violet-600"
				>
					{new Date(call.createdAt).toLocaleTimeString()}
				</DebugLink>
			</td>

			{/* Status */}
			<td className="px-3 py-2">
				<StatusBadge status={call.status} />
			</td>

			{/* Provider */}
			<td className="px-3 py-2 text-xs text-slate-500">
				{call.metrics?.provider ?? '—'}
			</td>

			{/* Model */}
			<td className="px-3 py-2">
				<DebugLink
					to={`llm-calls/${call.id}`}
					className="font-mono text-xs hover:text-violet-600"
				>
					{call.request.model.split('/').pop()}
				</DebugLink>
			</td>

			{/* Duration */}
			<td className="px-3 py-2 text-right font-mono text-xs">
				{latency !== undefined ? `${(latency / 1000).toFixed(2)}s` : '—'}
			</td>

			{/* Tokens */}
			<td className="px-3 py-2 text-right">
				<div className="font-mono text-xs">
					<span className="text-green-600">{promptTokens.toLocaleString()}</span>
					<span className="text-slate-400">/</span>
					<span className="text-violet-600">{completionTokens.toLocaleString()}</span>
				</div>
				<div className="text-xs text-slate-500">{totalTokens.toLocaleString()} total</div>
			</td>

			{/* Cost */}
			<td className="px-3 py-2 text-right font-mono text-xs">
				{cost !== undefined ? <span className="text-green-600">${cost.toFixed(5)}</span> : <span className="text-slate-400">—</span>}
			</td>

			{/* Agent */}
			<td className="px-3 py-2">
				<span title={call.agentId}>
					<DebugLink
						to={`agents/${call.agentId}`}
						className="text-xs text-slate-600 hover:text-violet-600 whitespace-nowrap"
					>
						{agentName}
					</DebugLink>
				</span>
			</td>
		</tr>
	)
}

function StatusBadge({ status }: { status: 'running' | 'success' | 'error' }) {
	const styles: Record<string, string> = {
		running: 'bg-yellow-100 text-yellow-700',
		success: 'bg-green-100 text-green-700',
		error: 'bg-red-100 text-red-700',
	}
	return (
		<span className={`text-xs px-2 py-0.5 rounded-full font-medium ${styles[status]}`}>
			{status}
		</span>
	)
}
