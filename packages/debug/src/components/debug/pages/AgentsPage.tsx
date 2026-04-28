import type { ProtocolAgentStatus, SessionId } from '@roj-ai/sdk'
import type { AgentTreeNode } from '@roj-ai/shared'
import { AgentId } from '@roj-ai/shared'
import type { RpcOutput } from '@roj-ai/shared/rpc'
import { useCallback, useEffect, useState } from 'react'
import { api, unwrap } from '@roj-ai/client'
import { useAgentTree, useEventStore } from '../../../stores/event-store'
import { useDebugContext } from '../DebugContext'
import { DebugLink, useDebugSessionId } from '../DebugNavigation'
import { AgentDetailPage } from './AgentDetailPage'

export function AgentsPage() {
	const sessionId = useDebugSessionId()
	const { params } = useDebugContext()

	// Get agent tree from event store (already loaded by DebugLayout)
	const agents = useAgentTree()
	const isLoading = useEventStore((s) => s.isLoading)
	const error = useEventStore((s) => s.error)

	const selectedAgentId = params.agentId ?? null

	return (
		<div className="h-full flex gap-4">
			{/* Agent Tree - Left Panel */}
			<div className="w-80 shrink-0 bg-white rounded-2xl shadow-card flex flex-col">
				<div className="p-3 border-b border-gray-100">
					<h2 className="font-semibold text-gray-900 text-sm">Agent Tree</h2>
				</div>
				<div className="flex-1 overflow-auto p-3">
					{isLoading && agents.length === 0
						? <div className="text-gray-400 text-sm">Loading...</div>
						: error
						? <div className="text-red-500 text-sm">{error}</div>
						: agents.length === 0
						? <div className="text-gray-400 text-sm">No agents yet</div>
						: (
							<div>
								{agents.map((agent, i) => (
									<AgentNode
										key={agent.id}
										agent={agent}
										selectedId={selectedAgentId}
										isLast={i === agents.length - 1}
										guides={[]}
									/>
								))}
							</div>
						)}
				</div>
				{selectedAgentId && (
					<SpawnAgentSection
						sessionId={sessionId}
						parentId={selectedAgentId}
						parentDefinitionName={findAgentDefinitionName(agents, selectedAgentId)}
					/>
				)}
			</div>

			{/* Agent Detail - Right Panel */}
			<div className="flex-1 bg-gray-50/50 rounded-2xl flex flex-col min-w-0">
				<div className="p-3 border-b border-gray-100">
					<h2 className="font-semibold text-gray-900 text-sm">Agent Detail</h2>
				</div>
				<div className="flex-1 overflow-auto p-4">
					{selectedAgentId
						? <AgentDetailPage agentId={selectedAgentId} />
						: (
							<div className="text-gray-400 text-sm">
								Select an agent from the tree to view details
							</div>
						)}
				</div>
			</div>
		</div>
	)
}

/**
 * Find the definitionName of an agent by its ID in the tree.
 */
function findAgentDefinitionName(agents: AgentTreeNode[], agentId: string): string | null {
	for (const agent of agents) {
		if (agent.id === agentId) return agent.definitionName
		const found = findAgentDefinitionName(agent.children, agentId)
		if (found) return found
	}
	return null
}

type PresetAgent = RpcOutput<'presets.getAgents'>['agents'][number]

function SpawnAgentSection({
	sessionId,
	parentId,
	parentDefinitionName,
}: {
	sessionId: SessionId
	parentId: string
	parentDefinitionName: string | null
}) {
	const [presetAgents, setPresetAgents] = useState<PresetAgent[]>([])
	const [selectedAgent, setSelectedAgent] = useState('')
	const [message, setMessage] = useState('')
	const [spawning, setSpawning] = useState(false)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		api.call('presets.getAgents', { sessionId }).then((result) => {
			setPresetAgents(unwrap(result).agents)
		}).catch(() => {
			setPresetAgents([])
		})
	}, [sessionId])

	// Filter agents spawnable by the selected parent
	const spawnableAgents = presetAgents.filter((a) => parentDefinitionName && a.spawnableBy.includes(parentDefinitionName))

	const handleSpawn = useCallback(async () => {
		if (!selectedAgent) return

		setSpawning(true)
		setError(null)

		try {
			unwrap(
				await api.call('agents.spawn', {
					sessionId,
					definitionName: selectedAgent,
					parentId: AgentId(parentId),
					message: message.trim() || undefined,
				}),
			)
			setSelectedAgent('')
			setMessage('')
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Failed to spawn agent')
		} finally {
			setSpawning(false)
		}
	}, [selectedAgent, sessionId, parentId, message])

	if (spawnableAgents.length === 0) return null

	return (
		<div className="p-3 border-t border-gray-100">
			<h3 className="text-xs font-medium text-gray-400 mb-2">Spawn Agent</h3>
			<div className="space-y-2">
				<select
					value={selectedAgent}
					onChange={(e) => setSelectedAgent(e.target.value)}
					className="w-full text-xs border border-gray-200 rounded px-2 py-1"
				>
					<option value="">Select agent...</option>
					{spawnableAgents.map((a) => (
						<option key={a.name} value={a.name}>
							{a.name}
							{a.hasInputSchema ? ' (typed)' : ''}
						</option>
					))}
				</select>
				<input
					type="text"
					value={message}
					onChange={(e) => setMessage(e.target.value)}
					placeholder="Initial message (optional)"
					className="w-full text-xs border border-gray-200 rounded px-2 py-1"
				/>
				{error && <div className="text-xs text-red-600">{error}</div>}
				<button
					onClick={handleSpawn}
					disabled={spawning || !selectedAgent}
					className="w-full px-2 py-1 text-xs font-medium text-white bg-green-600 rounded hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
				>
					{spawning ? 'Spawning...' : 'Spawn'}
				</button>
			</div>
		</div>
	)
}

const statusDotColors: Record<ProtocolAgentStatus, string> = {
	idle: 'bg-gray-400',
	thinking: 'bg-accent-lime animate-pulse',
	responding: 'bg-accent-peri',
	waiting_for_user: 'bg-purple-400',
	error: 'bg-red-400',
	paused: 'bg-amber-400',
}

const statusTextColors: Record<ProtocolAgentStatus, string> = {
	idle: 'text-gray-500',
	thinking: 'text-lime-600',
	responding: 'text-indigo-500',
	waiting_for_user: 'text-purple-500',
	error: 'text-red-500',
	paused: 'text-amber-500',
}

const statusLabels: Record<ProtocolAgentStatus, string> = {
	idle: 'idle',
	thinking: 'thinking',
	responding: 'responding',
	waiting_for_user: 'waiting',
	error: 'error',
	paused: 'paused',
}

function AgentNode({
	agent,
	selectedId,
	isLast,
	guides,
}: {
	agent: AgentTreeNode
	selectedId: string | null
	isLast: boolean
	guides: boolean[]
}) {
	const isSelected = selectedId === agent.id

	return (
		<>
			<div className="flex">
				{/* Ancestor vertical guide lines */}
				{guides.map((active, i) => (
					<div key={i} className="w-5 shrink-0 relative">
						{active && <div className="absolute left-2 top-0 bottom-0 w-px bg-gray-200" />}
					</div>
				))}

				{/* Branch connector (vertical + horizontal) */}
				<div className="w-5 shrink-0 relative">
					<div className={`absolute left-2 top-0 w-px bg-gray-200 ${isLast ? 'h-5' : 'h-full'}`} />
					<div className="absolute left-2 top-5 h-px w-2.5 bg-gray-200" />
				</div>

				{/* Node card */}
				<div className="flex-1 min-w-0 py-0.5">
					<DebugLink
						to={`agents/${agent.id}`}
						className={`block w-full text-left px-2.5 py-2 rounded-lg border transition-all ${
							isSelected
								? 'bg-accent-peri/15 border-accent-peri/40 border-l-[3px] border-l-accent-peri text-gray-900 shadow-sm'
								: 'bg-white border-gray-100 text-gray-700 hover:border-gray-200 hover:shadow-sm'
						}`}
					>
						{/* Row 1: status dot + name + right-aligned status/cost */}
						<div className="flex items-center gap-2">
							<span className={`w-2 h-2 rounded-full shrink-0 ${statusDotColors[agent.status]}`} />
							<span className="font-mono text-sm truncate font-medium">{agent.definitionName}</span>
							<span className="ml-auto flex items-center gap-1.5 shrink-0">
								<span className={`text-[10px] font-medium ${statusTextColors[agent.status]}`}>
									{statusLabels[agent.status]}
								</span>
								{agent.cost > 0 && (
									<span className="text-[10px] text-emerald-600 font-medium tabular-nums">${agent.cost.toFixed(4)}</span>
								)}
							</span>
						</div>

						{/* Row 2: badges + id */}
						<div className="flex items-center gap-1.5 ml-4 mt-1">
							{agent.isExecuting && (
								<span className="text-[10px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full font-semibold animate-pulse">
									exec
								</span>
							)}
							{agent.mailboxCount > 0 && (
								<span className="text-[10px] bg-orange-100 text-orange-600 px-1.5 py-0.5 rounded-full font-medium">
									{agent.mailboxCount} msgs
								</span>
							)}
							{agent.pendingToolCalls > 0 && (
								<span className="text-[10px] bg-accent-peri/15 text-gray-600 px-1.5 py-0.5 rounded-full font-medium">
									{agent.pendingToolCalls} tools
								</span>
							)}
							<span className="text-[10px] text-gray-400 font-mono ml-auto">{agent.id.slice(0, 8)}</span>
						</div>
					</DebugLink>
				</div>
			</div>

			{/* Children */}
			{agent.children.map((child, i) => (
				<AgentNode
					key={child.id}
					agent={child}
					selectedId={selectedId}
					isLast={i === agent.children.length - 1}
					guides={[...guides, !isLast]}
				/>
			))}
		</>
	)
}
