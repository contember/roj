import type { ChatMessage } from '@roj-ai/sdk'
import { AgentId } from '@roj-ai/shared'
import type { RpcClient } from '@roj-ai/shared/rpc'
import { connectWebSocket } from '../client.js'
import { formatChatMessage } from '../repl/formatter.js'
import { unwrap } from '../unwrap.js'

function isChatMessage(msg: unknown): msg is ChatMessage {
	return typeof msg === 'object' && msg !== null && 'type' in msg && 'timestamp' in msg
}

export async function messagesCommand(client: RpcClient, sessionId: string, json: boolean): Promise<void> {
	const { messages: rawMessages } = unwrap(await client.call('user-chat.getMessages', { sessionId }))
	const messages = rawMessages.filter(isChatMessage)

	if (json) {
		console.log(JSON.stringify(messages, null, 2))
		return
	}

	if (messages.length === 0) {
		console.log('No messages.')
		return
	}

	for (const msg of messages) {
		console.log(formatChatMessage(msg))
		console.log()
	}
}

export async function sendCommand(
	client: RpcClient,
	baseUrl: string,
	sessionId: string,
	content: string,
	wait: boolean,
	json: boolean,
): Promise<void> {
	const session = unwrap(await client.call('sessions.get', { sessionId }))
	if (!session.entryAgentId) {
		console.error('No entry agent found for session.')
		process.exit(1)
	}
	const { messageId } = unwrap(await client.call('user-chat.sendMessage', { sessionId, agentId: AgentId(session.entryAgentId), content }))

	if (!wait) {
		if (json) {
			console.log(JSON.stringify({ messageId }))
		} else {
			console.log(`Message sent: ${messageId}`)
		}
		return
	}

	// Wait for agent response via WebSocket
	const responsePromise = new Promise<string>((resolve, reject) => {
		const timeout = setTimeout(() => {
			connection.disconnect()
			reject(new Error('Timeout waiting for agent response'))
		}, 120_000)

		const connection = connectWebSocket(baseUrl, sessionId, {
			agentMessage: (payload) => {
				if (typeof payload !== 'object' || payload === null) return
				const input = payload as Record<string, unknown>
				if (typeof input.content !== 'string') return
				clearTimeout(timeout)
				connection.disconnect()
				resolve(input.content)
			},
			error: (payload) => {
				if (typeof payload !== 'object' || payload === null) return
				const input = payload as Record<string, unknown>
				if (typeof input.message !== 'string') return
				clearTimeout(timeout)
				connection.disconnect()
				reject(new Error(input.message))
			},
		})

		connection.connect().catch(reject)
	})

	const response = await responsePromise

	if (json) {
		console.log(JSON.stringify({ messageId, response }))
	} else {
		console.log(response)
	}
}
