import { SessionId } from '@roj-ai/shared'
import { RpcError } from '@roj-ai/shared/rpc'
import { createCliClient } from './client.js'
import { answerCommand } from './commands/answer.js'
import {
	agentCommand,
	agentsCommand,
	debugSendCommand,
	eventsCommand,
	llmCallCommand,
	llmCallsCommand,
	mailboxCommand,
	metricsCommand,
	presetAgentsCommand,
	spawnAgentCommand,
	timelineCommand,
} from './commands/debug.js'
import { messagesCommand, sendCommand } from './commands/messages.js'
import { presetsCommand } from './commands/presets.js'
import { sessionCloseCommand, sessionCreateCommand, sessionGetCommand, sessionsListCommand } from './commands/sessions.js'
import { startRepl } from './repl/repl.js'

const USAGE = `Usage:
  roj-cli [options]                                  Start REPL
  roj-cli <command> [args] [options]                  Non-interactive

Options:
  --url <url>     Server URL (default: http://localhost:2486, env: ROJ_URL)
  --json          Output as JSON (non-interactive only)

Commands:
  presets                                                List available presets
  sessions [--status active|closed|errored]              List sessions
  session-create <presetId>                              Create new session
  session-get <sessionId>                                Get session info
  session-close <sessionId>                              Close session
  messages <sessionId>                                   Get messages
  send <sessionId> <message> [--wait]                    Send message
  answer <sessionId> <questionId> <answer>               Answer agent question

Debug commands:
  events <sessionId> [--type <type>] [--agent <id>] [--limit N]   Show domain events
  agents <sessionId>                                               Show agent tree
  agent <sessionId> <agentId>                                      Show agent detail
  mailbox <sessionId>                                              Show global mailbox
  timeline <sessionId>                                             Show execution timeline
  metrics <sessionId>                                              Show session metrics
  llm-calls <sessionId> [--limit N]                                List LLM calls
  llm-call <sessionId> <callId>                                    Show LLM call detail
  preset-agents <sessionId>                                        Show spawnable agents
  debug-send <sessionId> <agentId> <message> [--from <sender>]     Send debug message
  spawn-agent <sessionId> <defName> <parentId> [--message <msg>]   Spawn agent manually`

interface ParsedArgs {
	url: string
	json: boolean
	command: string | null
	positional: string[]
	flags: Record<string, string | true>
}

function parseArgs(argv: string[]): ParsedArgs {
	// Skip bun and script path
	const args = argv.slice(2)

	let url = process.env.ROJ_URL ?? 'http://localhost:2486'
	let json = false
	const positional: string[] = []
	const flags: Record<string, string | true> = {}

	for (let i = 0; i < args.length; i++) {
		const arg = args[i]
		if (arg === '--url') {
			url = args[++i]
		} else if (arg === '--json') {
			json = true
		} else if (arg === '--help' || arg === '-h') {
			console.log(USAGE)
			process.exit(0)
		} else if (arg.startsWith('--')) {
			const key = arg.slice(2)
			const next = args[i + 1]
			if (next && !next.startsWith('--')) {
				flags[key] = next
				i++
			} else {
				flags[key] = true
			}
		} else {
			positional.push(arg)
		}
	}

	return {
		url,
		json,
		command: positional[0] ?? null,
		positional: positional.slice(1),
		flags,
	}
}

async function main(): Promise<void> {
	const parsed = parseArgs(process.argv)
	const client = createCliClient(parsed.url)

	// REPL mode if no command
	if (!parsed.command) {
		await startRepl(client, parsed.url)
		return
	}

	switch (parsed.command) {
		case 'presets':
			await presetsCommand(client, parsed.json)
			break

		case 'sessions': {
			const status = parsed.flags.status as 'active' | 'closed' | 'errored' | undefined
			await sessionsListCommand(client, typeof status === 'string' ? status : undefined, parsed.json)
			break
		}

		case 'session-create': {
			const presetId = parsed.positional[0]
			if (!presetId) {
				console.error('Usage: session-create <presetId>')
				process.exit(1)
			}
			await sessionCreateCommand(client, presetId, parsed.json)
			break
		}

		case 'session-get': {
			const sessionId = parsed.positional[0]
			if (!sessionId) {
				console.error('Usage: session-get <sessionId>')
				process.exit(1)
			}
			await sessionGetCommand(client, sessionId, parsed.json)
			break
		}

		case 'session-close': {
			const sessionId = parsed.positional[0]
			if (!sessionId) {
				console.error('Usage: session-close <sessionId>')
				process.exit(1)
			}
			await sessionCloseCommand(client, sessionId, parsed.json)
			break
		}

		case 'messages': {
			const sessionId = parsed.positional[0]
			if (!sessionId) {
				console.error('Usage: messages <sessionId>')
				process.exit(1)
			}
			await messagesCommand(client, sessionId, parsed.json)
			break
		}

		case 'send': {
			const sessionId = parsed.positional[0]
			const message = parsed.positional.slice(1).join(' ')
			if (!sessionId || !message) {
				console.error('Usage: send <sessionId> <message> [--wait]')
				process.exit(1)
			}
			const wait = parsed.flags.wait === true
			await sendCommand(client, parsed.url, sessionId, message, wait, parsed.json)
			break
		}

		case 'answer': {
			const sessionId = parsed.positional[0]
			const questionId = parsed.positional[1]
			const answer = parsed.positional.slice(2).join(' ')
			if (!sessionId || !questionId || !answer) {
				console.error('Usage: answer <sessionId> <questionId> <answer>')
				process.exit(1)
			}
			await answerCommand(client, sessionId, questionId, answer, parsed.json)
			break
		}

		// Debug commands
		case 'events': {
			const sessionId = parsed.positional[0]
			if (!sessionId) {
				console.error('Usage: events <sessionId> [--type <type>] [--agent <agentId>] [--limit N]')
				process.exit(1)
			}
			await eventsCommand(client, sessionId, parsed.flags, parsed.json)
			break
		}

		case 'agents': {
			const sessionId = parsed.positional[0]
			if (!sessionId) {
				console.error('Usage: agents <sessionId>')
				process.exit(1)
			}
			await agentsCommand(client, sessionId, parsed.json)
			break
		}

		case 'agent': {
			const sessionId = parsed.positional[0]
			const agentId = parsed.positional[1]
			if (!sessionId || !agentId) {
				console.error('Usage: agent <sessionId> <agentId>')
				process.exit(1)
			}
			await agentCommand(client, sessionId, agentId, parsed.json)
			break
		}

		case 'mailbox': {
			const sessionId = parsed.positional[0]
			if (!sessionId) {
				console.error('Usage: mailbox <sessionId>')
				process.exit(1)
			}
			await mailboxCommand(client, sessionId, parsed.json)
			break
		}

		case 'timeline': {
			const sessionId = parsed.positional[0]
			if (!sessionId) {
				console.error('Usage: timeline <sessionId>')
				process.exit(1)
			}
			await timelineCommand(client, sessionId, parsed.json)
			break
		}

		case 'metrics': {
			const sessionId = parsed.positional[0]
			if (!sessionId) {
				console.error('Usage: metrics <sessionId>')
				process.exit(1)
			}
			await metricsCommand(client, sessionId, parsed.json)
			break
		}

		case 'llm-calls': {
			const sessionId = parsed.positional[0]
			if (!sessionId) {
				console.error('Usage: llm-calls <sessionId> [--limit N]')
				process.exit(1)
			}
			await llmCallsCommand(client, sessionId, parsed.flags, parsed.json)
			break
		}

		case 'llm-call': {
			const sessionId = parsed.positional[0]
			const callId = parsed.positional[1]
			if (!sessionId || !callId) {
				console.error('Usage: llm-call <sessionId> <callId>')
				process.exit(1)
			}
			await llmCallCommand(client, sessionId, callId, parsed.json)
			break
		}

		case 'preset-agents': {
			const sessionId = parsed.positional[0]
			if (!sessionId) {
				console.error('Usage: preset-agents <sessionId>')
				process.exit(1)
			}
			await presetAgentsCommand(client, SessionId(sessionId), parsed.json)
			break
		}

		case 'debug-send': {
			const sessionId = parsed.positional[0]
			const agentId = parsed.positional[1]
			const message = parsed.positional.slice(2).join(' ')
			if (!sessionId || !agentId || !message) {
				console.error('Usage: debug-send <sessionId> <agentId> <message> [--from <sender>]')
				process.exit(1)
			}
			await debugSendCommand(client, sessionId, agentId, message, parsed.flags, parsed.json)
			break
		}

		case 'spawn-agent': {
			const sessionId = parsed.positional[0]
			const definitionName = parsed.positional[1]
			const parentId = parsed.positional[2]
			if (!sessionId || !definitionName || !parentId) {
				console.error('Usage: spawn-agent <sessionId> <definitionName> <parentId> [--message <msg>]')
				process.exit(1)
			}
			await spawnAgentCommand(client, sessionId, definitionName, parentId, parsed.flags, parsed.json)
			break
		}

		default:
			console.error(`Unknown command: ${parsed.command}`)
			console.error(USAGE)
			process.exit(1)
	}
}

main().catch((error) => {
	if (error instanceof RpcError) {
		console.error(`RPC Error [${error.error.type}]: ${error.error.message}`)
	} else {
		console.error(error instanceof Error ? error.message : String(error))
	}
	process.exit(1)
})
