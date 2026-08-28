import { describe, expect, it } from 'bun:test'
import {
	AgentId,
	agentEvents,
	contextEvents,
	createSessionState,
	definePlugin,
	getAgentMailbox,
	getAgentUnconsumedMailbox,
	llmEvents,
	mailboxEvents,
	selectMailboxState,
	SessionId,
	sessionEvents,
	toolEvents,
	userChatEvents,
} from './index.js'

/**
 * Guards the surface a third-party plugin needs to observe built-in events and
 * read built-in state — everything here used to require a deep `src/` import.
 */
describe('public exports', () => {
	it('lets a plugin react to the built-in event factories', () => {
		const observer = definePlugin('observer')
			.events([agentEvents, contextEvents, llmEvents, mailboxEvents, sessionEvents, toolEvents, userChatEvents])
			.state<number>({
				key: 'observed',
				initial: () => 0,
				reduce: (state, event) => (event.type === 'mailbox_message' || event.type === 'inference_completed' ? state + 1 : state),
			})
			.build()

		expect(observer.create().state?.key).toBe('observed')
	})

	it('reads built-in mailbox state off a session state', () => {
		const state = createSessionState(SessionId('s1'), 'preset', Date.now())
		const agentId = AgentId('a1')

		expect(getAgentMailbox(selectMailboxState(state), agentId)).toEqual([])
		expect(getAgentUnconsumedMailbox(selectMailboxState(state), agentId)).toEqual([])
	})
})
