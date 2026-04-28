import type { SessionMetadata } from '@roj-ai/sdk'
import { SessionId } from '@roj-ai/shared'
import type { RpcClient } from '@roj-ai/shared/rpc'
import * as readline from 'node:readline'
import { unwrap } from '../unwrap.js'

const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'

function ask(rl: readline.Interface, question: string): Promise<string> {
	return new Promise(resolve => {
		rl.question(question, resolve)
	})
}

function isSessionMetadata(data: unknown): data is SessionMetadata {
	return typeof data === 'object' && data !== null && 'sessionId' in data && 'presetId' in data
}

export async function pickSession(client: RpcClient, rl: readline.Interface): Promise<SessionId> {
	const { sessions: rawSessions } = unwrap(await client.call('sessions.list', { status: 'active', limit: 20, order: 'desc' }))
	const sessions = rawSessions.filter(isSessionMetadata)

	console.log()
	console.log(`${BOLD}Active sessions:${RESET}`)

	for (let i = 0; i < sessions.length; i++) {
		const s = sessions[i]
		const date = new Date(s.createdAt).toLocaleString()
		const name = s.name ? ` - ${s.name}` : ''
		console.log(`  ${BOLD}${i + 1})${RESET} ${s.sessionId.slice(0, 8)}... ${DIM}[${s.presetId}]${RESET}${name} ${DIM}${date}${RESET}`)
	}

	console.log(`  ${BOLD}n)${RESET} Create new session`)
	console.log()

	const choice = await ask(rl, 'Select session: ')

	if (choice.toLowerCase() === 'n') {
		return createNewSession(client, rl)
	}

	const index = parseInt(choice, 10) - 1
	if (index >= 0 && index < sessions.length) {
		return sessions[index].sessionId
	}

	console.log('Invalid choice, try again.')
	return pickSession(client, rl)
}

export async function createNewSession(client: RpcClient, rl: readline.Interface): Promise<SessionId> {
	const { presets } = unwrap(await client.call('presets.list', {}))

	if (presets.length === 0) {
		throw new Error('No presets available on the server.')
	}

	console.log()
	console.log(`${BOLD}Available presets:${RESET}`)

	for (let i = 0; i < presets.length; i++) {
		const p = presets[i]
		const desc = p.description ? ` - ${p.description}` : ''
		console.log(`  ${BOLD}${i + 1})${RESET} ${p.name}${DIM}${desc}${RESET}`)
	}
	console.log()

	const choice = await ask(rl, 'Select preset: ')
	const index = parseInt(choice, 10) - 1

	if (index < 0 || index >= presets.length) {
		console.log('Invalid choice, try again.')
		return createNewSession(client, rl)
	}

	const { sessionId } = unwrap(await client.call('sessions.create', { presetId: presets[index].id }))
	console.log(`Session created: ${sessionId}`)
	return SessionId(sessionId)
}
