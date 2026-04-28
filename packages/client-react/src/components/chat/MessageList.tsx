import type { ChatMessage } from '@roj-ai/shared'
import { AgentMessage } from './AgentMessage'
import { AskUserMessage } from './AskUserMessage'
import { UserMessage } from './UserMessage'

interface MessageListProps {
	messages: ChatMessage[]
	isAgentTyping: boolean
}

export function MessageList({ messages, isAgentTyping }: MessageListProps) {
	if (messages.length === 0 && !isAgentTyping) {
		return (
			<div className="text-center py-20">
				<div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-violet-100 to-blue-100 flex items-center justify-center mx-auto mb-4">
					<svg className="w-6 h-6 text-violet-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
						<path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
					</svg>
				</div>
				<p className="text-muted-foreground text-sm font-medium">No messages yet</p>
				<p className="text-muted-foreground/50 text-xs mt-1">Start a conversation below</p>
			</div>
		)
	}

	return (
		<div className="space-y-5">
			{messages.map((message) => {
				switch (message.type) {
					case 'user_message':
						return <UserMessage key={message.messageId} message={message} />
					case 'agent_message':
						return <AgentMessage key={message.messageId} message={message} />
					case 'ask_user':
						return <AskUserMessage key={message.questionId} message={message} />
				}
			})}

			{isAgentTyping && (
				<div className="flex items-center gap-3">
					<div className="w-7 h-7 rounded-lg bg-gradient-to-br from-violet-100 to-blue-100 flex items-center justify-center shrink-0">
						<svg className="w-3.5 h-3.5 text-violet-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
							<path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
						</svg>
					</div>
					<div className="flex gap-1">
						<span className="w-1.5 h-1.5 bg-violet-300 rounded-full animate-bounce" />
						<span
							className="w-1.5 h-1.5 bg-violet-300 rounded-full animate-bounce"
							style={{ animationDelay: '0.15s' }}
						/>
						<span
							className="w-1.5 h-1.5 bg-violet-300 rounded-full animate-bounce"
							style={{ animationDelay: '0.3s' }}
						/>
					</div>
				</div>
			)}
		</div>
	)
}
