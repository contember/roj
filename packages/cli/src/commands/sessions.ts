import type { SessionMetadata } from '@roj-ai/sdk'
import type { RpcClient } from '@roj-ai/shared/rpc'
import { formatSessionInfo, formatTable } from '../repl/formatter.js'
import { unwrap } from '../unwrap.js'

function isSessionMetadata(data: unknown): data is SessionMetadata {
	return typeof data === 'object' && data !== null && 'sessionId' in data && 'presetId' in data
}

export async function sessionsListCommand(
	client: RpcClient,
	status: 'active' | 'closed' | 'errored' | undefined,
	json: boolean,
): Promise<void> {
	const { sessions } = unwrap(await client.call('sessions.list', { status, limit: 50, order: 'desc' }))

	if (json) {
		console.log(JSON.stringify(sessions, null, 2))
		return
	}

	if (sessions.length === 0) {
		console.log('No sessions found.')
		return
	}

	console.log(formatTable(
		['Session ID', 'Preset', 'Status', 'Created'],
		sessions.filter(isSessionMetadata).map(s => [
			s.sessionId,
			s.presetId,
			s.status,
			new Date(s.createdAt).toLocaleString(),
		]),
	))
}

export async function sessionCreateCommand(client: RpcClient, presetId: string, json: boolean): Promise<void> {
	const { sessionId } = unwrap(await client.call('sessions.create', { presetId }))

	if (json) {
		console.log(JSON.stringify({ sessionId }))
		return
	}

	console.log(`Session created: ${sessionId}`)
}

export async function sessionGetCommand(client: RpcClient, sessionId: string, json: boolean): Promise<void> {
	const session = unwrap(await client.call('sessions.get', { sessionId }))

	if (json) {
		console.log(JSON.stringify(session, null, 2))
		return
	}

	console.log(formatSessionInfo(session))
	console.log(`  Agents: ${session.agentCount}`)
	if (session.closedAt) {
		console.log(`  Closed: ${new Date(session.closedAt).toLocaleString()}`)
	}
}

export async function sessionCloseCommand(client: RpcClient, sessionId: string, json: boolean): Promise<void> {
	const result = unwrap(await client.call('sessions.close', { sessionId }))

	if (json) {
		console.log(JSON.stringify(result))
		return
	}

	console.log('Session closed.')
}
