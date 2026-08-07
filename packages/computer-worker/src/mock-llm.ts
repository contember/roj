/**
 * Scripted LLM for the smoke run — no network, deterministic.
 *
 * Branches on the tools offered to the caller: the orchestrator sees
 * `start_writer`, the writer sees `write_file`. Each acts once, then stops.
 */

import type { MockInferenceHandler } from '@roj-ai/sdk'
import { MockLLMProvider } from '@roj-ai/sdk'
import { ToolCallId } from '@roj-ai/sdk/tools'

const NOTE_PATH = '/home/user/workspace/note.md'
const NOTE_CONTENT = '# Written from a Worker isolate\n\nStored in the workspace SQLite filesystem.\n'

let toolCallSeq = 0

function toolCall(name: string, input: unknown) {
	toolCallSeq += 1
	return { id: ToolCallId(`mock-call-${toolCallSeq}`), name, input }
}

function hasCalled(messages: readonly { role: string; toolCalls?: unknown[] }[], name: string): boolean {
	return messages.some((message) =>
		message.role === 'assistant'
		&& Array.isArray(message.toolCalls)
		&& message.toolCalls.some((call) => (call as { name?: string }).name === name),
	)
}

export const scriptedHandler: MockInferenceHandler = (request) => {
	const offered = new Set((request.tools ?? []).map((tool) => tool.name))
	const metrics = MockLLMProvider.defaultMetrics()

	if (offered.has('start_writer') && !hasCalled(request.messages, 'start_writer')) {
		return {
			content: 'Delegating to the writer agent.',
			toolCalls: [toolCall('start_writer', { message: `Write ${NOTE_PATH}.` })],
			finishReason: 'tool_calls',
			metrics,
		}
	}

	if (offered.has('write_file') && !offered.has('start_writer') && !hasCalled(request.messages, 'write_file')) {
		return {
			content: `Writing ${NOTE_PATH}.`,
			toolCalls: [toolCall('write_file', { path: NOTE_PATH, content: NOTE_CONTENT })],
			finishReason: 'tool_calls',
			metrics,
		}
	}

	return { content: 'Done.', toolCalls: [], finishReason: 'stop', metrics }
}

export { NOTE_CONTENT, NOTE_PATH }
