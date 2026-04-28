import type { AgentTreeNode } from '@roj-ai/shared'
import type { BuiltinEvent, DomainEvent } from '@roj-ai/sdk'
import { useMemo } from 'react'
import type { DiagramData, DiagramLLMBlock, DiagramMessage, DiagramParticipant, DiagramToolBlock, ParticipantRole, ParticipantStatus } from '../types'
import { useTimeCompression } from './useTimeCompression'

interface UseDiagramDataProps {
	events: DomainEvent[]
	agents: AgentTreeNode[]
}

export function useDiagramData({ events, agents }: UseDiagramDataProps): DiagramData & {
	timestampToY: (timestamp: number) => number
	formatIdleDuration: (ms: number) => string
} {
	// Extract all timestamps for compression
	const timestamps = useMemo(() => {
		return events.map((e) => e.timestamp).sort((a, b) => a - b)
	}, [events])

	const { segments, totalHeight, timestampToY, formatIdleDuration } = useTimeCompression(timestamps)

	// Build participants from agents
	const participants = useMemo((): DiagramParticipant[] => {
		const result: DiagramParticipant[] = []

		// User is always first
		const sessionStart = events.find((e) => e.type === 'session_created')?.timestamp ?? Date.now()
		result.push({
			id: 'user',
			name: 'User',
			role: 'user',
			spawnedAt: sessionStart,
			status: 'idle',
			columnIndex: 0,
		})

		// Flatten agent tree with BFS to maintain hierarchy order
		const flattenAgents = (nodes: AgentTreeNode[], parentRole: ParticipantRole | null = null): void => {
			for (const agent of nodes) {
				const role = determineRole(agent.definitionName, parentRole)
				result.push({
					id: agent.id as DiagramParticipant['id'],
					name: formatAgentName(agent.definitionName),
					role,
					spawnedAt: getAgentSpawnTime(events, agent.id),
					status: mapAgentStatus(agent.status),
					columnIndex: result.length,
				})
				flattenAgents(agent.children, role)
			}
		}

		flattenAgents(agents)

		return result
	}, [agents, events])

	// Build messages from mailbox events with parallel message offset
	const messages = useMemo((): DiagramMessage[] => {
		const rawMessages: DiagramMessage[] = []

		for (const event of events) {
			const e = event as BuiltinEvent
			if (e.type === 'mailbox_message') {
				const fromId = e.message.from === 'user' ? 'user' : e.message.from
				rawMessages.push({
					id: e.message.id,
					fromId: fromId as DiagramMessage['fromId'],
					toId: e.toAgentId,
					timestamp: e.timestamp,
					content: e.message.content,
					yPosition: timestampToY(e.timestamp),
				})
			}

			// User messages to agents (sent via send_message endpoint)
			if (e.type === 'user_message_sent') {
				rawMessages.push({
					id: e.messageId,
					fromId: e.agentId,
					toId: 'user',
					timestamp: e.timestamp,
					content: e.message,
					yPosition: timestampToY(e.timestamp),
				})
			}
		}

		// Sort by timestamp
		rawMessages.sort((a, b) => a.timestamp - b.timestamp)

		// Offset parallel messages (same timestamp or within 100ms)
		const PARALLEL_THRESHOLD_MS = 100
		const MESSAGE_Y_OFFSET = 14

		const result: DiagramMessage[] = []
		let parallelGroup: DiagramMessage[] = []

		for (const msg of rawMessages) {
			if (parallelGroup.length === 0) {
				parallelGroup.push(msg)
			} else {
				const lastMsg = parallelGroup[parallelGroup.length - 1]
				if (Math.abs(msg.timestamp - lastMsg.timestamp) <= PARALLEL_THRESHOLD_MS) {
					parallelGroup.push(msg)
				} else {
					// Process previous group
					result.push(...offsetParallelMessages(parallelGroup, MESSAGE_Y_OFFSET))
					parallelGroup = [msg]
				}
			}
		}

		// Process last group
		if (parallelGroup.length > 0) {
			result.push(...offsetParallelMessages(parallelGroup, MESSAGE_Y_OFFSET))
		}

		return result
	}, [events, timestampToY])

	// Build LLM blocks from inference events
	const llmBlocks = useMemo((): DiagramLLMBlock[] => {
		const result: DiagramLLMBlock[] = []
		const pendingInferences = new Map<string, { event: Extract<BuiltinEvent, { type: 'inference_started' }>; idx: number }>()

		for (const event of events) {
			const e = event as BuiltinEvent
			if (e.type === 'inference_started') {
				const idx = result.length
				result.push({
					id: `llm-${e.agentId}-${e.timestamp}`,
					participantId: e.agentId,
					startTime: e.timestamp,
					status: 'running',
					yStart: timestampToY(e.timestamp),
					yEnd: timestampToY(e.timestamp) + 30, // Minimum height
				})
				pendingInferences.set(e.agentId, { event: e, idx })
			}

			if (e.type === 'inference_completed') {
				const pending = pendingInferences.get(e.agentId)
				if (pending) {
					result[pending.idx] = {
						...result[pending.idx],
						endTime: e.timestamp,
						status: 'success',
						model: e.metrics.model,
						tokens: e.metrics.totalTokens,
						llmCallId: e.llmCallId,
						yEnd: timestampToY(e.timestamp),
					}
					pendingInferences.delete(e.agentId)
				}
			}

			if (e.type === 'inference_failed') {
				const pending = pendingInferences.get(e.agentId)
				if (pending) {
					result[pending.idx] = {
						...result[pending.idx],
						endTime: e.timestamp,
						status: 'error',
						llmCallId: e.llmCallId,
						yEnd: timestampToY(e.timestamp),
					}
					pendingInferences.delete(e.agentId)
				}
			}
		}

		return result
	}, [events, timestampToY])

	// Build tool blocks from tool events
	const toolBlocks = useMemo((): DiagramToolBlock[] => {
		const result: DiagramToolBlock[] = []
		const pendingTools = new Map<string, { event: Extract<BuiltinEvent, { type: 'tool_started' }>; idx: number }>()

		for (const event of events) {
			const e = event as BuiltinEvent
			if (e.type === 'tool_started') {
				const idx = result.length
				result.push({
					id: `tool-${e.toolCallId}`,
					toolCallId: e.toolCallId,
					participantId: e.agentId,
					toolName: e.toolName,
					startTime: e.timestamp,
					status: 'running',
					yStart: timestampToY(e.timestamp),
					yEnd: timestampToY(e.timestamp) + 20, // Minimum height
				})
				pendingTools.set(e.toolCallId, { event: e, idx })
			}

			if (e.type === 'tool_completed') {
				const pending = pendingTools.get(e.toolCallId)
				if (pending) {
					result[pending.idx] = {
						...result[pending.idx],
						endTime: e.timestamp,
						status: 'success',
						yEnd: timestampToY(e.timestamp),
					}
					pendingTools.delete(e.toolCallId)
				}
			}

			if (e.type === 'tool_failed') {
				const pending = pendingTools.get(e.toolCallId)
				if (pending) {
					result[pending.idx] = {
						...result[pending.idx],
						endTime: e.timestamp,
						status: 'error',
						yEnd: timestampToY(e.timestamp),
					}
					pendingTools.delete(e.toolCallId)
				}
			}
		}

		return result
	}, [events, timestampToY])

	const sessionStartTime = useMemo(() => {
		const sessionCreated = events.find((e) => e.type === 'session_created')
		return sessionCreated?.timestamp ?? Date.now()
	}, [events])

	return {
		participants,
		messages,
		llmBlocks,
		toolBlocks,
		timeSegments: segments,
		totalHeight,
		sessionStartTime,
		timestampToY,
		formatIdleDuration,
	}
}

// Helper functions

function determineRole(definitionName: string, parentRole: ParticipantRole | null): ParticipantRole {
	const lower = definitionName.toLowerCase()
	if (lower.includes('communicator')) return 'communicator'
	if (lower.includes('orchestrator')) return 'orchestrator'
	if (parentRole === 'orchestrator' || parentRole === 'worker') return 'worker'
	if (parentRole === null) return 'communicator' // Root agent without orchestrator
	return 'worker'
}

function formatAgentName(definitionName: string): string {
	// Convert kebab-case or snake_case to Title Case
	return definitionName
		.replace(/[-_]/g, ' ')
		.replace(/\b\w/g, (c) => c.toUpperCase())
		.replace(/^Entry$/, 'Entry Agent')
}

function getAgentSpawnTime(events: DomainEvent[], agentId: string): number {
	const spawnEvent = events.find(
		(e) => e.type === 'agent_spawned' && 'agentId' in e && (e as BuiltinEvent & { type: 'agent_spawned' }).agentId === agentId,
	)
	return spawnEvent?.timestamp ?? Date.now()
}

function mapAgentStatus(status: AgentTreeNode['status']): ParticipantStatus {
	// AgentTreeNode.status is from common-schemas AgentStatus:
	// "idle" | "thinking" | "responding" | "waiting_for_user" | "error"
	// which matches ParticipantStatus exactly
	return status
}

function offsetParallelMessages(messages: DiagramMessage[], offset: number): DiagramMessage[] {
	if (messages.length <= 1) {
		return messages
	}

	// Center the group around the original Y position
	const baseY = messages[0].yPosition
	const totalHeight = (messages.length - 1) * offset
	const startY = baseY - totalHeight / 2

	return messages.map((msg, idx) => ({
		...msg,
		yPosition: startY + idx * offset,
	}))
}
