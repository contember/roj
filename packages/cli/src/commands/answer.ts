import { AgentId, ChatMessageId } from '@roj-ai/shared'
import type { RpcClient } from '@roj-ai/shared/rpc'
import { unwrap } from '../unwrap.js'

export async function answerCommand(
	client: RpcClient,
	sessionId: string,
	questionId: string,
	answer: string,
	json: boolean,
): Promise<void> {
	const session = unwrap(await client.call('sessions.get', { sessionId }))
	if (!session.entryAgentId) {
		console.error('No entry agent found for session.')
		process.exit(1)
	}
	const result = unwrap(
		await client.call('user-chat.answerQuestion', { sessionId, agentId: AgentId(session.entryAgentId), questionId: ChatMessageId(questionId), answer }),
	)

	if (json) {
		console.log(JSON.stringify(result))
		return
	}

	console.log('Answer submitted.')
}
