import type { UserChatMessage } from '@roj-ai/shared'
import { SparklesIcon } from 'lucide-react'

const SYSTEM_TAG_RE = /^<system>([\s\S]*)<\/system>$/

interface UserMessageProps {
	message: UserChatMessage
}

export function UserMessage({ message }: UserMessageProps) {
	if (SYSTEM_TAG_RE.test(message.content.trim())) {
		// `<system>...</system>` messages are agent-only context (sent by the
		// worker for things like rebase handoff). The body is technical and
		// not meant for users — show a generic status chip instead.
		return <SystemMessage timestamp={message.timestamp} />
	}

	return (
		<div className="flex flex-col items-end pl-14">
			<div className="max-w-full bg-foreground text-background rounded-2xl rounded-br-sm px-4 py-2.5 shadow-sm shadow-foreground/5">
				<p className="whitespace-pre-wrap text-sm leading-relaxed">{message.content}</p>
			</div>
			<p className="text-[10px] text-muted-foreground/40 mt-1.5 mr-1">
				{new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
			</p>
		</div>
	)
}

function SystemMessage({ timestamp }: { timestamp: number }) {
	return (
		<div className="flex items-center gap-3 py-2">
			<div className="flex-1 h-px bg-border/60" />
			<span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground/60 shrink-0">
				<SparklesIcon className="size-3" />
				AI is updating your project
				<span className="text-muted-foreground/40 ml-0.5">
					{new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
				</span>
			</span>
			<div className="flex-1 h-px bg-border/60" />
		</div>
	)
}
