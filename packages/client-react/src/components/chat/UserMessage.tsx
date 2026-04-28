import type { UserChatMessage } from '@roj-ai/shared'

const SYSTEM_TAG_RE = /^<system>([\s\S]*)<\/system>$/

interface UserMessageProps {
	message: UserChatMessage
}

export function UserMessage({ message }: UserMessageProps) {
	const systemMatch = SYSTEM_TAG_RE.exec(message.content.trim())
	if (systemMatch) {
		return <SystemMessage content={systemMatch[1].trim()} timestamp={message.timestamp} />
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

function SystemMessage({ content }: { content: string; timestamp: number }) {
	return (
		<div className="flex items-center gap-3 py-2">
			<div className="flex-1 h-px bg-border/60" />
			<span className="text-[11px] text-muted-foreground/50 shrink-0">{content}</span>
			<div className="flex-1 h-px bg-border/60" />
		</div>
	)
}
