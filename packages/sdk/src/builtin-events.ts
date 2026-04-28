/**
 * BuiltinEvent — Union of all built-in plugin event types.
 *
 * This type is the client-side equivalent of ProjectionEvent in projections.ts.
 * Use it to narrow DomainEvent to access event-specific properties after type checks.
 */

import type { agentEvents } from '~/core/agents/state.js'
import type { contextEvents } from '~/core/context/state.js'
import type { FactoryEventType } from '~/core/events/types.js'
import type { llmEvents } from '~/core/llm/state.js'
import type { sessionEvents } from '~/core/sessions/state.js'
import type { toolEvents } from '~/core/tools/state.js'
import type { mailboxEvents } from '~/plugins/mailbox/state.js'
import type { userChatEvents } from '~/plugins/user-chat/plugin.js'

export type BuiltinEvent = FactoryEventType<
	| typeof agentEvents
	| typeof sessionEvents
	| typeof toolEvents
	| typeof llmEvents
	| typeof contextEvents
	| typeof mailboxEvents
	| typeof userChatEvents
>
