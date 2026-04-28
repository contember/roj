import { describe, expect, test } from 'bun:test'
import type { DebounceContext } from '~/core/agents/debounce.js'
import {
	aggressiveDebounceCallback,
	batchingDebounceCallback,
	defaultDebounceCallback,
	waitForResponseDebounceCallback,
} from '~/core/agents/debounce.js'
import { MailboxMessage, MessageId } from '../../plugins/mailbox/schema'
import { PendingToolResult, ToolCallId } from '../tools/schema'
import { AgentId } from './schema'

describe('Debounce Callbacks', () => {
	const createMessage = (timestampOffset = 0): MailboxMessage => ({
		id: MessageId('msg-1'),
		from: AgentId('agent-1'),
		content: 'Test message',
		timestamp: Date.now() - timestampOffset,
		consumed: false,
	})

	const createToolResult = (
		toolName: string,
		timestampOffset = 0,
		isError = false,
	): PendingToolResult => ({
		toolCallId: ToolCallId('tc-1'),
		toolName,
		timestamp: Date.now() - timestampOffset,
		isError,
		content: '',
	})

	const createContext = (
		messageCount: number,
		oldestWaitingMs: number,
		pendingToolResults: PendingToolResult[] = [],
	): DebounceContext => ({
		messages: Array.from({ length: messageCount }, () => createMessage()),
		oldestWaitingMs,
		totalPending: messageCount,
		pendingToolResults,
	})

	describe('defaultDebounceCallback', () => {
		test("returns 'wait' when oldest message is less than 500ms old", () => {
			const context = createContext(1, 400)
			expect(defaultDebounceCallback(context)).toBe('wait')
		})

		test("returns 'wait' when oldest message is exactly 500ms old", () => {
			const context = createContext(1, 500)
			expect(defaultDebounceCallback(context)).toBe('wait')
		})

		test("returns 'process_now' when oldest message is more than 500ms old", () => {
			const context = createContext(1, 501)
			expect(defaultDebounceCallback(context)).toBe('process_now')
		})

		test("returns 'process_now' regardless of message count", () => {
			const context = createContext(10, 600)
			expect(defaultDebounceCallback(context)).toBe('process_now')
		})
	})

	describe('aggressiveDebounceCallback', () => {
		test("returns 'wait' when oldest message is less than 100ms old", () => {
			const context = createContext(1, 50)
			expect(aggressiveDebounceCallback(context)).toBe('wait')
		})

		test("returns 'wait' when oldest message is exactly 100ms old", () => {
			const context = createContext(1, 100)
			expect(aggressiveDebounceCallback(context)).toBe('wait')
		})

		test("returns 'process_now' when oldest message is more than 100ms old", () => {
			const context = createContext(1, 101)
			expect(aggressiveDebounceCallback(context)).toBe('process_now')
		})

		test('processes faster than default callback', () => {
			const context = createContext(1, 150)
			// Aggressive should process, default should wait
			expect(aggressiveDebounceCallback(context)).toBe('process_now')
			expect(defaultDebounceCallback(context)).toBe('wait')
		})
	})

	describe('batchingDebounceCallback', () => {
		test("returns 'wait' with few messages and short wait time", () => {
			const context = createContext(2, 500)
			expect(batchingDebounceCallback(context)).toBe('wait')
		})

		test("returns 'process_now' when 5 or more messages", () => {
			const context = createContext(5, 100)
			expect(batchingDebounceCallback(context)).toBe('process_now')
		})

		test("returns 'process_now' when more than 5 messages", () => {
			const context = createContext(10, 50)
			expect(batchingDebounceCallback(context)).toBe('process_now')
		})

		test("returns 'wait' when oldest message is exactly 2000ms old with few messages", () => {
			const context = createContext(2, 2000)
			expect(batchingDebounceCallback(context)).toBe('wait')
		})

		test("returns 'process_now' when oldest message is more than 2000ms old", () => {
			const context = createContext(1, 2001)
			expect(batchingDebounceCallback(context)).toBe('process_now')
		})

		test("returns 'process_now' at threshold of 5 messages", () => {
			const context = createContext(5, 0)
			expect(batchingDebounceCallback(context)).toBe('process_now')
		})

		test("returns 'wait' just below message threshold", () => {
			const context = createContext(4, 1500)
			expect(batchingDebounceCallback(context)).toBe('wait')
		})
	})

	describe('waitForResponseDebounceCallback', () => {
		test("returns 'process_now' when there are new mailbox messages", () => {
			const context = createContext(1, 100, [
				createToolResult('send_message', 1000),
			])
			expect(waitForResponseDebounceCallback(context)).toBe('process_now')
		})

		test("returns 'wait' when all pending tool results are communication tools", () => {
			const context = createContext(0, 0, [
				createToolResult('send_message', 1000),
			])
			expect(waitForResponseDebounceCallback(context)).toBe('wait')
		})

		test("returns 'wait' for start_* agent tool", () => {
			const context = createContext(0, 0, [
				createToolResult('start_researcher', 1000),
			])
			expect(waitForResponseDebounceCallback(context)).toBe('wait')
		})

		test("returns 'wait' for tell_user tool", () => {
			const context = createContext(0, 0, [
				createToolResult('tell_user', 1000),
			])
			expect(waitForResponseDebounceCallback(context)).toBe('wait')
		})

		test("returns 'wait' for ask_user tool", () => {
			const context = createContext(0, 0, [
				createToolResult('ask_user', 1000),
			])
			expect(waitForResponseDebounceCallback(context)).toBe('wait')
		})

		test("returns 'wait' when multiple communication tools are pending", () => {
			const context = createContext(0, 0, [
				createToolResult('send_message', 1000),
				createToolResult('start_helper', 500),
			])
			expect(waitForResponseDebounceCallback(context)).toBe('wait')
		})

		test("returns 'process_now' when ANY tool result is not a communication tool", () => {
			const context = createContext(0, 0, [
				createToolResult('send_message', 1000),
				createToolResult('reveal_secret', 500), // Not a communication tool
			])
			expect(waitForResponseDebounceCallback(context)).toBe('process_now')
		})

		test("returns 'process_now' for non-communication tool alone", () => {
			const context = createContext(0, 0, [
				createToolResult('get_my_info', 1000),
			])
			expect(waitForResponseDebounceCallback(context)).toBe('process_now')
		})

		test("returns 'process_now' when any tool result has isError=true", () => {
			const context = createContext(0, 0, [
				createToolResult('send_message', 1000, true), // Error!
			])
			expect(waitForResponseDebounceCallback(context)).toBe('process_now')
		})

		test("returns 'process_now' when mixed success and error results", () => {
			const context = createContext(0, 0, [
				createToolResult('send_message', 2000, false), // Success
				createToolResult('start_worker', 1000, true), // Error - should trigger immediate processing
			])
			expect(waitForResponseDebounceCallback(context)).toBe('process_now')
		})

		test("returns 'process_now' after 60s timeout for communication tools", () => {
			const context = createContext(0, 0, [
				createToolResult('send_message', 61000), // 61 seconds ago
			])
			expect(waitForResponseDebounceCallback(context)).toBe('process_now')
		})

		test("returns 'wait' just before 60s timeout", () => {
			const context = createContext(0, 0, [
				createToolResult('send_message', 59000), // 59 seconds ago
			])
			expect(waitForResponseDebounceCallback(context)).toBe('wait')
		})

		test("returns 'wait' when no messages and no tool results", () => {
			const context = createContext(0, 0, [])
			expect(waitForResponseDebounceCallback(context)).toBe('wait')
		})

		test('uses oldest tool result timestamp for timeout calculation', () => {
			// One tool result at 59s, one at 30s - should use 59s (oldest)
			const now = Date.now()
			const context: DebounceContext = {
				messages: [],
				oldestWaitingMs: 0,
				totalPending: 0,
				pendingToolResults: [
					{ toolCallId: ToolCallId('tc-1'), toolName: 'send_message', timestamp: now - 59000, isError: false, content: '' },
					{ toolCallId: ToolCallId('tc-2'), toolName: 'send_message', timestamp: now - 30000, isError: false, content: '' },
				],
			}
			expect(waitForResponseDebounceCallback(context)).toBe('wait')

			// Now make oldest one 61s old
			context.pendingToolResults[0].timestamp = now - 61000
			expect(waitForResponseDebounceCallback(context)).toBe('process_now')
		})
	})
})
