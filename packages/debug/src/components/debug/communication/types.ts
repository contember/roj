import type { AgentId, LLMCallId, ToolCallId } from '@roj-ai/sdk'

// ============================================================================
// Participant types
// ============================================================================

export type ParticipantRole = 'user' | 'communicator' | 'orchestrator' | 'worker'

export type ParticipantStatus = 'idle' | 'thinking' | 'responding' | 'waiting_for_user' | 'error' | 'paused'

export interface DiagramParticipant {
	id: AgentId | 'user'
	name: string
	role: ParticipantRole
	spawnedAt: number
	status: ParticipantStatus
	columnIndex: number
}

// ============================================================================
// Message types
// ============================================================================

export interface DiagramMessage {
	id: string
	fromId: AgentId | 'user'
	toId: AgentId | 'user'
	timestamp: number
	content: string
	yPosition: number
}

// ============================================================================
// LLM Block types
// ============================================================================

export type BlockStatus = 'running' | 'success' | 'error'

export interface DiagramLLMBlock {
	id: string
	llmCallId?: LLMCallId
	participantId: AgentId
	startTime: number
	endTime?: number
	status: BlockStatus
	model?: string
	tokens?: number
	yStart: number
	yEnd: number
}

// ============================================================================
// Tool Block types
// ============================================================================

export interface DiagramToolBlock {
	id: string
	toolCallId: ToolCallId
	participantId: AgentId
	toolName: string
	startTime: number
	endTime?: number
	status: BlockStatus
	yStart: number
	yEnd: number
}

// ============================================================================
// Time compression types
// ============================================================================

export type TimeSegmentType = 'active' | 'idle'

export interface TimeSegment {
	startTime: number
	endTime: number
	type: TimeSegmentType
	displayHeight: number
	actualDuration: number
}

export interface TimeCompressionConfig {
	pixelsPerSecond: number
	maxIdleHeight: number
	idleThresholdMs: number
}

// ============================================================================
// Diagram data types
// ============================================================================

export interface DiagramData {
	participants: DiagramParticipant[]
	messages: DiagramMessage[]
	llmBlocks: DiagramLLMBlock[]
	toolBlocks: DiagramToolBlock[]
	timeSegments: TimeSegment[]
	totalHeight: number
	sessionStartTime: number
}

// ============================================================================
// Zoom/Pan state
// ============================================================================

export interface ZoomPanState {
	zoom: number
	scrollY: number
	autoScroll: boolean
}

// ============================================================================
// Popover state
// ============================================================================

export type PopoverElement =
	| { type: 'message'; data: DiagramMessage }
	| { type: 'llm'; data: DiagramLLMBlock }
	| { type: 'tool'; data: DiagramToolBlock }
	| { type: 'idle'; data: TimeSegment }

export interface PopoverState {
	element: PopoverElement | null
	x: number
	y: number
}

// ============================================================================
// Layout constants
// ============================================================================

export const LAYOUT = {
	timeAxisWidth: 60,
	participantWidth: 100,
	participantGap: 40,
	headerHeight: 56,
	laneLineWidth: 1,
	blockWidth: 70,
	blockMinHeight: 24,
	idleGapHeight: 32,
	padding: 20,
	messageArrowOffset: 6, // Vertical offset for arrow to not overlap with blocks
} as const

export const COLORS = {
	message: {
		stroke: 'stroke-blue-400',
		fill: 'fill-blue-50',
		text: 'text-blue-600',
	},
	llm: {
		stroke: 'stroke-violet-300',
		fill: 'fill-violet-50',
		fillRunning: 'fill-violet-100',
		text: 'text-violet-600',
	},
	tool: {
		stroke: 'stroke-teal-300',
		fill: 'fill-teal-50',
		fillRunning: 'fill-teal-100',
		text: 'text-teal-600',
	},
	error: {
		stroke: 'stroke-red-300',
		fill: 'fill-red-50',
		text: 'text-red-600',
	},
	idle: {
		stroke: 'stroke-slate-200',
		fill: 'fill-slate-50',
		text: 'text-slate-400',
	},
	participant: {
		user: 'text-blue-600',
		communicator: 'text-emerald-600',
		orchestrator: 'text-violet-600',
		worker: 'text-slate-600',
	},
	lane: 'stroke-slate-100',
} as const
