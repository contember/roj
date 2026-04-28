import type { ChatMessage, SessionId } from '@roj-ai/sdk'
import type { AskUserInputTypeSchema } from '@roj-ai/sdk'
import { AgentId, ChatMessageId } from '@roj-ai/shared'

function isChatMessage(msg: unknown): msg is ChatMessage {
	return typeof msg === 'object' && msg !== null && 'type' in msg && 'timestamp' in msg
}
import type { RpcClient } from '@roj-ai/shared/rpc'
import * as readline from 'node:readline'
import { connectWebSocket, type NotificationHandlers, type WsConnection } from '../client.js'
import { unwrap } from '../unwrap.js'
import { formatAgentMessage, formatChatMessage, formatError, formatQuestion, formatStatus } from './formatter.js'
import { createNewSession, pickSession } from './session-picker.js'

const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

export async function startRepl(client: RpcClient, baseUrl: string): Promise<void> {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	})

	console.log(`${DIM}Connected to ${baseUrl}${RESET}`)
	console.log(`${DIM}Commands: /quit, /sessions, /new, /messages, /help${RESET}`)

	let sessionId = await pickSession(client, rl)
	let entryAgentId = await resolveEntryAgentId(client, sessionId)
	await loadAndDisplayMessages(client, sessionId)

	let pendingQuestion: { questionId: string; inputType: AskUserInputTypeSchema } | null = null

	const handlers: NotificationHandlers = {
		agentMessage: (payload) => {
			if (typeof payload !== 'object' || payload === null) return
			const input = payload as Record<string, unknown>
			if (typeof input.content !== 'string') return
			readline.clearLine(process.stdout, 0)
			readline.cursorTo(process.stdout, 0)
			console.log(formatAgentMessage(input.content))
			rl.prompt()
		},
		askUser: (payload) => {
			if (typeof payload !== 'object' || payload === null) return
			const input = payload as Record<string, unknown>
			if (typeof input.questionId !== 'string' || typeof input.question !== 'string') return
			readline.clearLine(process.stdout, 0)
			readline.cursorTo(process.stdout, 0)
			console.log(formatQuestion(input.question, input.inputType as AskUserInputTypeSchema))
			pendingQuestion = { questionId: input.questionId, inputType: input.inputType as AskUserInputTypeSchema }
			rl.prompt()
		},
		agentStatus: (payload) => {
			if (typeof payload !== 'object' || payload === null) return
			const input = payload as Record<string, unknown>
			if (typeof input.status !== 'string') return
			const statusLabels: Record<string, string> = {
				idle: 'Agent idle',
				thinking: 'Agent thinking...',
				responding: 'Agent responding...',
				waiting_for_user: 'Waiting for your input',
				error: 'Agent error',
			}
			readline.clearLine(process.stdout, 0)
			readline.cursorTo(process.stdout, 0)
			console.log(formatStatus(statusLabels[input.status] ?? input.status))
			rl.prompt()
		},
		error: (payload) => {
			if (typeof payload !== 'object' || payload === null) return
			const input = payload as Record<string, unknown>
			if (typeof input.message !== 'string') return
			readline.clearLine(process.stdout, 0)
			readline.cursorTo(process.stdout, 0)
			console.log(formatError(input.message))
			rl.prompt()
		},
	}

	let connection = connectWebSocket(baseUrl, sessionId, handlers)
	await connection.connect()

	rl.setPrompt('> ')
	rl.prompt()

	rl.on('line', async (line) => {
		const input = line.trim()
		if (!input) {
			rl.prompt()
			return
		}

		if (input.startsWith('/')) {
			const handled = await handleSlashCommand(input, client, baseUrl, rl, sessionId, connection)
			if (handled === 'quit') {
				await connection.disconnect()
				rl.close()
				return
			}
			if (handled !== false) {
				// Session switch
				await connection.disconnect()
				sessionId = handled
				entryAgentId = await resolveEntryAgentId(client, sessionId)
				connection = connectWebSocket(baseUrl, sessionId, handlers)
				await connection.connect()
				await loadAndDisplayMessages(client, sessionId)
			}
			rl.prompt()
			return
		}

		// Handle pending question answer
		if (pendingQuestion && entryAgentId) {
			const answer = parseAnswer(input, pendingQuestion.inputType)
			unwrap(
				await client.call('user-chat.answerQuestion', {
					sessionId,
					agentId: AgentId(entryAgentId),
					questionId: ChatMessageId(pendingQuestion.questionId),
					answer,
				}),
			)
			pendingQuestion = null
			rl.prompt()
			return
		}

		// Send message
		if (entryAgentId) {
			unwrap(await client.call('user-chat.sendMessage', { sessionId, agentId: AgentId(entryAgentId), content: input }))
		}
		rl.prompt()
	})

	rl.on('close', async () => {
		await connection.disconnect()
		process.exit(0)
	})
}

async function resolveEntryAgentId(client: RpcClient, sessionId: SessionId): Promise<string | null> {
	const session = unwrap(await client.call('sessions.get', { sessionId }))
	return session.entryAgentId
}

async function loadAndDisplayMessages(client: RpcClient, sessionId: SessionId): Promise<void> {
	const { messages: rawMessages } = unwrap(await client.call('user-chat.getMessages', { sessionId }))
	const messages = rawMessages.filter(isChatMessage)
	if (messages.length > 0) {
		console.log()
		console.log(`${DIM}--- Message history ---${RESET}`)
		for (const msg of messages) {
			console.log(formatChatMessage(msg))
			console.log()
		}
		console.log(`${DIM}--- End of history ---${RESET}`)
		console.log()
	}
}

type SlashResult = 'quit' | SessionId | false

async function handleSlashCommand(
	input: string,
	client: RpcClient,
	_baseUrl: string,
	rl: readline.Interface,
	currentSessionId: SessionId,
	_connection: WsConnection,
): Promise<SlashResult> {
	const [cmd] = input.split(/\s+/)

	switch (cmd) {
		case '/quit':
		case '/exit':
		case '/q':
			return 'quit'

		case '/sessions': {
			const newSessionId = await pickSession(client, rl)
			if (newSessionId !== currentSessionId) {
				return newSessionId
			}
			return false
		}

		case '/new': {
			const newSessionId = await createNewSession(client, rl)
			return newSessionId
		}

		case '/messages': {
			await loadAndDisplayMessages(client, currentSessionId)
			return false
		}

		case '/help':
			console.log(`${DIM}Commands:${RESET}`)
			console.log(`  /quit, /exit, /q  - Exit the REPL`)
			console.log(`  /sessions         - Switch to another session`)
			console.log(`  /new              - Create a new session`)
			console.log(`  /messages         - Show message history`)
			console.log(`  /help             - Show this help`)
			return false

		default:
			console.log(`Unknown command: ${cmd}. Type /help for available commands.`)
			return false
	}
}

function parseAnswer(input: string, inputType: AskUserInputTypeSchema): unknown {
	switch (inputType.type) {
		case 'text':
			return input

		case 'single_choice': {
			const index = parseInt(input, 10) - 1
			if (index >= 0 && index < inputType.options.length) {
				return inputType.options[index].value
			}
			return input
		}

		case 'multi_choice': {
			const indices = input.split(',').map(s => parseInt(s.trim(), 10) - 1)
			return indices
				.filter(i => i >= 0 && i < inputType.options.length)
				.map(i => inputType.options[i].value)
		}

		case 'confirm': {
			const lower = input.toLowerCase()
			return lower === 'y' || lower === 'yes' || lower === '1' || lower === 'true'
		}

		case 'rating': {
			const num = parseInt(input, 10)
			if (num >= inputType.min && num <= inputType.max) {
				return num
			}
			return parseInt(input, 10)
		}
	}
}
