import { DebugLink, useDebugParams, useDebugSessionId } from '../DebugNavigation.js'
import { LLMCallDetail } from '../LLMCallDetail.js'

export function LLMCallPage() {
	const sessionId = useDebugSessionId()
	const { callId } = useDebugParams<{ callId: string }>()

	if (!callId) {
		return <div className="text-slate-500">Invalid URL</div>
	}

	return (
		<div className="space-y-4">
			{/* Breadcrumb */}
			<div className="flex items-center gap-2 text-sm">
				<DebugLink
					to="llm-calls"
					className="text-violet-600 hover:underline"
				>
					LLM Calls
				</DebugLink>
				<span className="text-slate-400">/</span>
				<span className="text-slate-600 font-mono">{callId.slice(0, 12)}...</span>
			</div>

			{/* Detail */}
			<div className="bg-white rounded-md border border-slate-200 p-6">
				<LLMCallDetail sessionId={sessionId} callId={callId} />
			</div>
		</div>
	)
}
