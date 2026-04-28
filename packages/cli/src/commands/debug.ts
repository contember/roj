import type { DomainEvent, LLMCallLogEntry, SessionId } from '@roj-ai/sdk'
import type { GetAgentDetailResponse, ProjectionEvent } from '@roj-ai/shared'
import {
	type AgentDetailProjectionState,
	AgentId,
	type AgentRegistryState,
	type AgentTreeProjectionState,
	applyEventToAgentDetail,
	applyEventToAgentRegistry,
	applyEventToAgentTree,
	applyEventToMailbox,
	applyEventToMetrics,
	applyEventToTimeline,
	buildAgentTreeFromProjection,
	createAgentDetailProjectionState,
	createAgentRegistryState,
	createAgentTreeProjectionState,
	createMailboxState,
	createMetricsState,
	createTimelineState,
	getAgentDetail,
	getMailboxMessages,
	getTimelineItems,
	isDomainEvent,
	metricsStateToResponse,
} from '@roj-ai/shared'
import type { RpcClient, RpcOutput } from '@roj-ai/shared/rpc'
import { formatTable } from '../repl/formatter.js'
import { unwrap } from '../unwrap.js'
import {
	formatAgentDetail,
	formatAgentTree,
	formatEventRow,
	formatLLMCallDetail,
	formatMailboxMessage,
	formatMetrics,
	formatTimelineItem,
	truncate,
} from './debug-format.js'

// ============================================================================
// Helpers
// ============================================================================

function isLLMCallLogEntry(data: unknown): data is LLMCallLogEntry {
	return typeof data === 'object' && data !== null && 'id' in data && 'status' in data && 'request' in data
}

interface LoadedProjections {
	registry: AgentRegistryState
	agentTree: AgentTreeProjectionState
	agentDetail: AgentDetailProjectionState
	events: DomainEvent[]
}

async function loadProjections(client: RpcClient, sessionId: string): Promise<LoadedProjections> {
	const { events: rawEvents } = unwrap(await client.call('sessions.getEvents', { sessionId, limit: 10000 }))
	const events = rawEvents.filter(isDomainEvent)

	let registry = createAgentRegistryState()
	let agentTree = createAgentTreeProjectionState()
	let agentDetail = createAgentDetailProjectionState()

	for (const event of events) {
		const e = event as ProjectionEvent
		registry = applyEventToAgentRegistry(registry, e)
		agentTree = applyEventToAgentTree(agentTree, e)
		agentDetail = applyEventToAgentDetail(agentDetail, e)
	}

	return { registry, agentTree, agentDetail, events }
}

// ============================================================================
// Direct RPC Commands
// ============================================================================

export async function eventsCommand(
	client: RpcClient,
	sessionId: string,
	flags: Record<string, string | true>,
	json: boolean,
): Promise<void> {
	const limit = typeof flags.limit === 'string' ? parseInt(flags.limit, 10) : undefined
	const type = typeof flags.type === 'string' ? flags.type : undefined
	const agentId = typeof flags.agent === 'string' ? flags.agent : undefined

	const { events: rawEvents, total } = unwrap(await client.call('sessions.getEvents', { sessionId, limit, type, agentId }))
	const events = rawEvents.filter(isDomainEvent)

	if (json) {
		console.log(JSON.stringify({ events, total }, null, 2))
		return
	}

	if (events.length === 0) {
		console.log('No events found.')
		return
	}

	console.log(formatTable(
		['#', 'Type', 'Agent', 'Time'],
		events.map((e, i) => formatEventRow(e, i)),
	))
	console.log(`\nTotal: ${total} events`)
}

export async function llmCallsCommand(
	client: RpcClient,
	sessionId: string,
	flags: Record<string, string | true>,
	json: boolean,
): Promise<void> {
	const limit = typeof flags.limit === 'string' ? parseInt(flags.limit, 10) : undefined

	const { calls, total } = unwrap(await client.call('llm.getCalls', { sessionId, limit }))

	if (json) {
		console.log(JSON.stringify({ calls, total }, null, 2))
		return
	}

	if (calls.length === 0) {
		console.log('No LLM calls found.')
		return
	}

	const typedCalls = calls.filter(isLLMCallLogEntry)
	console.log(formatTable(
		['Time', 'Status', 'Model', 'Duration', 'Tokens', 'Cost', 'Agent'],
		typedCalls.map((c) => {
			const time = new Date(c.createdAt).toLocaleTimeString()
			const duration = c.durationMs !== undefined ? `${(c.durationMs / 1000).toFixed(1)}s` : '-'
			const tokens = c.metrics ? `${c.metrics.promptTokens}/${c.metrics.completionTokens}` : '-'
			const cost = c.metrics?.cost !== undefined ? `$${c.metrics.cost.toFixed(4)}` : '-'
			return [time, c.status, c.request.model, duration, tokens, cost, String(c.agentId)]
		}),
	))
	console.log(`\nTotal: ${total} calls`)
}

export async function llmCallCommand(
	client: RpcClient,
	sessionId: string,
	callId: string,
	json: boolean,
): Promise<void> {
	const callData = unwrap(await client.call('llm.getCall', { sessionId, callId }))

	if (json) {
		console.log(JSON.stringify(callData, null, 2))
		return
	}

	if (!isLLMCallLogEntry(callData)) {
		console.error('Invalid LLM call data.')
		return
	}

	console.log(formatLLMCallDetail(callData))
}

export async function presetAgentsCommand(
	client: RpcClient,
	sessionId: SessionId,
	json: boolean,
): Promise<void> {
	const result = unwrap(await client.call('presets.getAgents', { sessionId }))
	const agents = result.agents

	if (json) {
		console.log(JSON.stringify(agents, null, 2))
		return
	}

	if (agents.length === 0) {
		console.log('No agent definitions found.')
		return
	}

	type PresetAgent = RpcOutput<'presets.getAgents'>['agents'][number]
	console.log(formatTable(
		['Name', 'Spawnable By', 'Has Input Schema'],
		agents.map((a: PresetAgent) => [a.name, a.spawnableBy.join(', '), a.hasInputSchema ? 'yes' : 'no']),
	))
}

export async function debugSendCommand(
	client: RpcClient,
	sessionId: string,
	agentId: string,
	content: string,
	flags: Record<string, string | true>,
	json: boolean,
): Promise<void> {
	const { messageId } = unwrap(await client.call('user-chat.sendMessage', { sessionId, agentId: AgentId(agentId), content }))

	if (json) {
		console.log(JSON.stringify({ messageId }))
		return
	}

	console.log(`Message sent: ${messageId}`)
}

export async function spawnAgentCommand(
	client: RpcClient,
	sessionId: string,
	definitionName: string,
	parentId: string,
	flags: Record<string, string | true>,
	json: boolean,
): Promise<void> {
	const message = typeof flags.message === 'string' ? flags.message : undefined
	const { agentId } = unwrap(await client.call('agents.spawn', { sessionId, definitionName, parentId: AgentId(parentId), message }))

	if (json) {
		console.log(JSON.stringify({ agentId }))
		return
	}

	console.log(`Agent spawned: ${agentId}`)
}

// ============================================================================
// Event-sourced Projection Commands
// ============================================================================

export async function agentsCommand(
	client: RpcClient,
	sessionId: string,
	json: boolean,
): Promise<void> {
	const { agentTree: agentTreeState } = await loadProjections(client, sessionId)
	const tree = buildAgentTreeFromProjection(agentTreeState)

	if (json) {
		console.log(JSON.stringify(tree, null, 2))
		return
	}

	if (tree.length === 0) {
		console.log('No agents.')
		return
	}

	console.log(formatAgentTree(tree))
}

export async function agentCommand(
	client: RpcClient,
	sessionId: string,
	agentId: string,
	json: boolean,
): Promise<void> {
	const { agentDetail: agentDetailState } = await loadProjections(client, sessionId)
	const detail = getAgentDetail(agentDetailState, AgentId(agentId))

	if (!detail) {
		console.error(`Agent not found: ${agentId}`)
		process.exit(1)
	}

	if (json) {
		console.log(JSON.stringify(detail, null, 2))
		return
	}

	console.log(formatAgentDetail(detail))
}

export async function mailboxCommand(
	client: RpcClient,
	sessionId: string,
	json: boolean,
): Promise<void> {
	const { registry, events } = await loadProjections(client, sessionId)

	let mailboxState = createMailboxState()
	for (const event of events) {
		mailboxState = applyEventToMailbox(mailboxState, event as ProjectionEvent, registry)
	}
	const messages = getMailboxMessages(mailboxState)

	if (json) {
		console.log(JSON.stringify(messages, null, 2))
		return
	}

	if (messages.length === 0) {
		console.log('No mailbox messages.')
		return
	}

	for (const msg of messages) {
		console.log(formatMailboxMessage(msg))
	}
}

export async function timelineCommand(
	client: RpcClient,
	sessionId: string,
	json: boolean,
): Promise<void> {
	const { registry, events } = await loadProjections(client, sessionId)

	let timelineState = createTimelineState()
	for (const event of events) {
		timelineState = applyEventToTimeline(timelineState, event as ProjectionEvent, registry)
	}
	const items = getTimelineItems(timelineState, registry)

	if (json) {
		console.log(JSON.stringify(items, null, 2))
		return
	}

	if (items.length === 0) {
		console.log('No timeline items.')
		return
	}

	for (const item of items) {
		console.log(formatTimelineItem(item))
	}
}

export async function metricsCommand(
	client: RpcClient,
	sessionId: string,
	json: boolean,
): Promise<void> {
	const { registry, events } = await loadProjections(client, sessionId)

	let metricsState = createMetricsState()
	for (const event of events) {
		metricsState = applyEventToMetrics(metricsState, event as ProjectionEvent)
	}
	const metrics = metricsStateToResponse(metricsState, registry.count)

	if (json) {
		console.log(JSON.stringify(metrics, null, 2))
		return
	}

	console.log(formatMetrics(metrics))
}
