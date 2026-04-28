import type { AgentChatMessage } from '@roj-ai/shared'
import { Marked } from 'marked'
import { useMemo } from 'react'

const marked = new Marked({
	breaks: true,
})

interface AgentMessageProps {
	message: AgentChatMessage
}

export function AgentMessage({ message }: AgentMessageProps) {
	const html = useMemo(() => marked.parse(message.content, { async: false }), [message.content])

	return (
		<div className="flex gap-3 pr-10">
			<div className="w-7 h-7 rounded-lg bg-gradient-to-br from-violet-100 to-blue-100 flex items-center justify-center shrink-0 mt-0.5">
				<svg className="w-3.5 h-3.5 text-violet-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
					<path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
				</svg>
			</div>
			<div className="min-w-0 flex-1">
				<div
					className="prose-agent text-sm text-foreground/85"
					// biome-ignore lint/security/noDangerouslySetInnerHtml: markdown rendering
					dangerouslySetInnerHTML={{ __html: html }}
				/>
				<p className="text-[10px] text-muted-foreground/40 mt-2">
					{new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
				</p>
			</div>
		</div>
	)
}
