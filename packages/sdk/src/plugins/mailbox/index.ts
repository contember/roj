/**
 * Mailbox plugin - inter-agent communication
 */

export { type MailboxAgentConfig, mailboxPlugin, type MailboxPresetConfig } from './plugin.js'

export { type MailboxConsumedEvent, mailboxEvents, type MailboxMessageEvent, type MailboxMessageSender } from './state.js'

export { canCommunicateWith, getCommunicableAgents } from './helpers.js'

export { generateMessageId, generateTestMessageId, type MailboxMessage, MessageId, messageIdSchema } from './schema.js'

export { getAgentMailbox, getAgentUnconsumedMailbox, getNextMessageSeq, type MailboxPluginState, selectMailboxState } from './query.js'
