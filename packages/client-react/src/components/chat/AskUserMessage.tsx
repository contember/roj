import type { AskUserChatMessage } from '@roj-ai/shared'
import { CheckIcon } from 'lucide-react'

interface AskUserMessageProps {
	message: AskUserChatMessage
}

export function AskUserMessage({ message }: AskUserMessageProps) {
	return (
		<div className="flex gap-3">
			<div className="w-7 h-7 rounded-lg bg-gradient-to-br from-amber-100 to-orange-100 flex items-center justify-center shrink-0 mt-0.5">
				<svg className="w-3.5 h-3.5 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
					<path strokeLinecap="round" strokeLinejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9 5.25h.008v.008H12v-.008z" />
				</svg>
			</div>
			<div className="flex-1 min-w-0">
				<div className="bg-gradient-to-br from-amber-50/80 to-orange-50/60 rounded-xl px-4 py-3 text-sm border border-amber-200/40">
					<p className="whitespace-pre-wrap leading-relaxed text-foreground/80">{message.question}</p>
					{message.answered && message.answer !== undefined && (
						<div className="mt-2.5 pt-2.5 border-t border-amber-200/40">
							<p className="text-sm">
								<span className="text-muted-foreground">Your answer:</span>{' '}
								<span className="font-medium">{typeof message.answer === 'string'
									? message.answer
									: JSON.stringify(message.answer)}</span>
							</p>
						</div>
					)}
				</div>
				<div className="flex items-center justify-between gap-2 mt-1.5 px-1">
					<p className="text-[10px] text-muted-foreground/40">
						{new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
					</p>
					{message.answered && (
						<div className="text-[10px] text-emerald-600 flex gap-1 items-center font-medium">
							<CheckIcon className="w-3 h-3" />
							Answered
						</div>
					)}
				</div>
			</div>
		</div>
	)
}
