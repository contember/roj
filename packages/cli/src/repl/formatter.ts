import type { AskUserInputTypeSchema } from '@roj-ai/sdk'
import type { ChatMessage } from '@roj-ai/shared/rpc'

// ANSI color codes
const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const CYAN = '\x1b[36m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const MAGENTA = '\x1b[35m'

export function formatAgentMessage(content: string): string {
	return `${CYAN}${BOLD}Agent:${RESET} ${content}`
}

export function formatUserMessage(content: string): string {
	return `${GREEN}${BOLD}You:${RESET} ${content}`
}

export function formatStatus(status: string): string {
	return `${DIM}[${status}]${RESET}`
}

export function formatError(message: string): string {
	return `${RED}Error: ${message}${RESET}`
}

export function formatQuestion(question: string, inputType: AskUserInputTypeSchema): string {
	const lines = [`${YELLOW}${BOLD}Question:${RESET} ${question}`]

	if (inputType.type === 'single_choice' || inputType.type === 'multi_choice') {
		for (let i = 0; i < inputType.options.length; i++) {
			const opt = inputType.options[i]
			const desc = opt.description ? ` - ${opt.description}` : ''
			lines.push(`  ${MAGENTA}${i + 1})${RESET} ${opt.label}${DIM}${desc}${RESET}`)
		}
		if (inputType.type === 'single_choice') {
			lines.push(`${DIM}Enter number to select:${RESET}`)
		} else {
			lines.push(`${DIM}Enter numbers separated by commas:${RESET}`)
		}
	} else if (inputType.type === 'confirm') {
		const confirmLabel = inputType.confirmLabel ?? 'yes'
		const cancelLabel = inputType.cancelLabel ?? 'no'
		lines.push(`${DIM}(${confirmLabel}/${cancelLabel}):${RESET}`)
	} else if (inputType.type === 'rating') {
		lines.push(`${DIM}Enter a number from ${inputType.min} to ${inputType.max}:${RESET}`)
	}

	return lines.join('\n')
}

export function formatChatMessage(msg: ChatMessage): string {
	switch (msg.type) {
		case 'user_message':
			return formatUserMessage(msg.content)
		case 'agent_message':
			return formatAgentMessage(msg.content)
		case 'ask_user': {
			const answered = msg.answered ? `${DIM} (answered: ${JSON.stringify(msg.answer)})${RESET}` : ''
			return formatQuestion(msg.question, msg.inputType) + answered
		}
	}
}

export function formatSessionInfo(session: { sessionId: string; presetId: string; status: string; createdAt: number }): string {
	const date = new Date(session.createdAt).toLocaleString()
	return `${BOLD}${session.sessionId}${RESET} ${DIM}[${session.presetId}]${RESET} ${session.status} ${DIM}${date}${RESET}`
}

export function formatTable(headers: string[], rows: string[][]): string {
	const colWidths = headers.map((h, i) => {
		const maxDataWidth = rows.reduce((max, row) => Math.max(max, (row[i] ?? '').length), 0)
		return Math.max(h.length, maxDataWidth)
	})

	const headerLine = headers.map((h, i) => h.padEnd(colWidths[i])).join('  ')
	const separator = colWidths.map(w => '─'.repeat(w)).join('──')
	const dataLines = rows.map(row => row.map((cell, i) => (cell ?? '').padEnd(colWidths[i])).join('  '))

	return [headerLine, separator, ...dataLines].join('\n')
}
