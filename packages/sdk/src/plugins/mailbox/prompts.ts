import type { MailboxMessage } from './schema.js'

// ============================================================================
// Role briefing sections for system prompt composition
// ============================================================================

/**
 * Briefing for entry agents (orchestrator without communicator).
 * Entry agents can communicate directly with users and orchestrate children.
 */
export const ENTRY_ROLE_SECTION = `## Your Role: Entry Agent (Orchestrator)

You are the entry point for user communication AND you orchestrate child agents. See your available tools for capabilities.`

/**
 * Reporting instructions for child agents.
 * Child agents cannot communicate with users directly.
 */
export const CHILD_REPORTING_SECTION = `## Your Role: Child Agent

You were spawned by a parent agent to handle a specific task. You CANNOT communicate with users directly. See your available tools for capabilities.

Focus on completing your assigned task.

## Reporting (MANDATORY)

**You MUST always report back to your parent via \`send_message\` with \`to: "parent"\` before stopping.** This is the most important rule — your parent is waiting for your response and cannot proceed without it.

- **Task completed**: Call \`send_message\` with \`to: "parent"\` and a structured final result summarizing what you accomplished and any relevant outputs.
- **Task failed / blocked**: If you encounter an error, are blocked, or cannot complete the task for any reason, you MUST still call \`send_message\` with \`to: "parent"\` explaining what went wrong and what you attempted.
- **Progress updates**: For long-running tasks, report progress to your parent periodically via \`send_message\` with \`to: "parent"\`.

**Never stop without calling \`send_message\` with \`to: "parent"\`.** Silent termination leaves your parent stuck waiting indefinitely.`

/**
 * Reporting instructions for orchestrator agents (when there's a communicator).
 */
export const ORCHESTRATOR_REPORTING_SECTION = `## Your Role: Orchestrator

You coordinate work and spawn child agents to complete tasks. You do NOT communicate directly with users. See your available tools for capabilities.

You receive tasks from the communicator via \`send_message\`. The communicator's agent ID is in the \`from\` field of the message you receive.

## Reporting (MANDATORY)

**You MUST always report back to the communicator via \`send_message\` before stopping.** The communicator is waiting for your response and cannot update the user without it.

- **Task completed**: Send a structured result summarizing what was accomplished.
- **Task failed / blocked**: If you cannot complete the task, you MUST still send a message explaining what went wrong.
- **Progress updates**: For long-running tasks, report progress to the communicator periodically.

**Never stop without sending a message to the communicator.** Silent termination leaves the communicator and user stuck waiting indefinitely.`

/**
 * Message flow instructions for communicator agents.
 */
export const COMMUNICATOR_FLOW_SECTION = `## Your Role: Communicator

You handle user communication and relay messages to/from the orchestrator. See your available tools for capabilities.

## Message Flow

- User messages arrive to you first
- Forward tasks to the orchestrator via \`send_message\` (use the orchestrator's agent ID from messages)
- When the orchestrator reports back, format and relay the results to the user via \`tell_user\``

// ============================================================================
// Mailbox formatting
// ============================================================================

export const formatMailboxForLLM = (messages: MailboxMessage[], currentTimestamp?: number): string => {
	const formattedMessages = messages
		.map((m) => {
			const from = m.from === 'user' ? 'user' : m.from
			// Format answer messages with XML wrapper for LLM
			let content = m.answerTo
				? `<answer questionId="${m.answerTo}">\n${JSON.stringify(m.answerValue)}\n</answer>`
				: m.content

			// Add attachment information if present
			if (m.attachments && m.attachments.length > 0) {
				const attachmentBlocks = m.attachments.map((att) => {
					const innerContent = att.extractedContent
						? att.extractedContent
						: `[File uploaded: ${att.filename}]`
					return `<attachment uploadId="${att.uploadId}" filename="${att.filename}" type="${att.mimeType}" path="${att.path}">\n${innerContent}\n</attachment>`
				})
				content = content + '\n' + attachmentBlocks.join('\n')
			}

			// Add context block if present (visible to LLM only)
			if (m.context) {
				content = content + `\n<message-context>\n${m.context}\n</message-context>`
			}

			// Add timestamp attribute to message tag
			return `<message from="${from}" timestamp="${m.timestamp}">\n${content}\n</message>`
		})
		.join('\n\n')

	// Add info block with current timestamp at the end
	const now = currentTimestamp ?? Date.now()
	return formattedMessages + `\n\n<info>\n  <currentTime>${new Date(now).toISOString()}</currentTime>\n</info>`
}
