import type { PendingQuestion, QuestionSubmitStatus } from '../../stores/session-store.js'

interface QuestionnaireSummaryProps {
	questions: PendingQuestion[]
	draftAnswers: Map<string, unknown>
	questionSubmitStatus: Map<string, QuestionSubmitStatus>
	onEdit: () => void
	onSubmit: () => void
	isSubmitting: boolean
}

export function QuestionnaireSummary({
	questions,
	draftAnswers,
	questionSubmitStatus,
	onEdit,
	onSubmit,
	isSubmitting,
}: QuestionnaireSummaryProps) {
	const hasFailedQuestions = Array.from(questionSubmitStatus.values()).some(
		(status) => status === 'error',
	)
	const submittedCount = Array.from(questionSubmitStatus.values()).filter(
		(status) => status === 'success',
	).length

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<h3 className="text-sm font-medium text-gray-800">Review Your Answers</h3>
				<button
					onClick={onEdit}
					disabled={isSubmitting}
					className="text-xs text-gray-500 hover:text-gray-700 disabled:opacity-50 transition-colors"
				>
					Edit
				</button>
			</div>

			<div className="space-y-2">
				{questions.map((q, index) => {
					const answer = draftAnswers.get(q.questionId)
					const status = questionSubmitStatus.get(q.questionId) ?? 'idle'

					return (
						<div
							key={q.questionId}
							className={`p-3 rounded-xl border transition-colors ${
								status === 'error'
									? 'border-red-200 bg-red-50/50'
									: status === 'success'
									? 'border-emerald-200 bg-emerald-50/50'
									: 'border-gray-200 bg-gray-50/50'
							}`}
						>
							<div className="flex items-start gap-2">
								<span className="text-xs font-medium text-gray-400 mt-0.5">
									{index + 1}.
								</span>
								<div className="flex-1 min-w-0">
									<p className="text-xs text-gray-500">{q.question}</p>
									<p className="mt-0.5 text-sm font-medium text-gray-800">
										{formatAnswer(answer)}
									</p>
									{status === 'error' && <p className="mt-1 text-[10px] text-red-500">Failed to submit</p>}
									{status === 'success' && <p className="mt-1 text-[10px] text-emerald-500">Submitted</p>}
									{status === 'submitting' && <p className="mt-1 text-[10px] text-gray-400">Submitting...</p>}
								</div>
							</div>
						</div>
					)
				})}
			</div>

			{submittedCount > 0 && submittedCount < questions.length && (
				<div className="text-xs text-gray-400">
					{submittedCount} of {questions.length} submitted
				</div>
			)}

			<button
				onClick={onSubmit}
				disabled={isSubmitting}
				className="w-full px-4 py-2.5 bg-gray-900 text-white text-sm rounded-xl hover:bg-gray-800 disabled:bg-gray-200 disabled:text-gray-400 disabled:cursor-not-allowed font-medium transition-colors"
			>
				{isSubmitting
					? 'Submitting...'
					: hasFailedQuestions
					? 'Retry Failed'
					: 'Submit All'}
			</button>
		</div>
	)
}

function formatAnswer(answer: unknown): string {
	if (answer === undefined) return '(not answered)'
	if (typeof answer === 'boolean') return answer ? 'Yes' : 'No'
	if (typeof answer === 'string') return answer || '(empty)'
	if (Array.isArray(answer)) return answer.join(', ') || '(none selected)'
	return String(answer)
}
