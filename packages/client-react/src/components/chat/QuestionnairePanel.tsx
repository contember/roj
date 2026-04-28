import { useMemo, useState } from 'react'
import { type PendingQuestion, useSessionStore } from '../../stores/session-store'
import { QuestionItem } from './QuestionItem'

interface QuestionnairePanelProps {
	questions: PendingQuestion[]
}

export function QuestionnairePanel({ questions }: QuestionnairePanelProps) {
	const [isSubmitting, setIsSubmitting] = useState(false)

	const draftAnswers = useSessionStore((s) => s.draftAnswers)
	const questionSubmitStatus = useSessionStore((s) => s.questionSubmitStatus)
	const setDraftAnswer = useSessionStore((s) => s.setDraftAnswer)
	const submitAllAnswers = useSessionStore((s) => s.submitAllAnswers)

	const answeredCount = useMemo(() => {
		return questions.filter((q) => draftAnswers.has(q.questionId)).length
	}, [questions, draftAnswers])

	const allAnswered = answeredCount === questions.length

	const handleSubmitAll = async () => {
		setIsSubmitting(true)
		try {
			await submitAllAnswers()
		} finally {
			setIsSubmitting(false)
		}
	}

	// Single question - simplified UI
	if (questions.length === 1) {
		const q = questions[0]
		const answer = draftAnswers.get(q.questionId)
		const hasAnswer = answer !== undefined

		return (
			<div className="bg-gradient-to-br from-amber-50/60 to-orange-50/40 border border-amber-200/40 rounded-2xl p-4">
				<div className="flex items-center gap-2 mb-3">
					<div className="w-5 h-5 rounded-md bg-gradient-to-br from-amber-100 to-orange-100 flex items-center justify-center">
						<svg className="w-3 h-3 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
							<path strokeLinecap="round" strokeLinejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9 5.25h.008v.008H12v-.008z" />
						</svg>
					</div>
					<p className="text-[11px] font-semibold text-amber-700/80 uppercase tracking-wider">
						Agent is asking
					</p>
				</div>
				<div className="space-y-3">
					<QuestionItem
						key={q.questionId}
						questionId={q.questionId}
						question={q.question}
						inputType={q.inputType}
						draftAnswer={answer}
						submitStatus={questionSubmitStatus.get(q.questionId) ?? 'idle'}
						onAnswerChange={setDraftAnswer}
						questionNumber={1}
						totalQuestions={1}
					/>
					{hasAnswer && (
						<button
							onClick={handleSubmitAll}
							disabled={isSubmitting}
							className="w-full px-4 py-2.5 bg-foreground text-background text-sm rounded-xl hover:bg-foreground/90 disabled:bg-muted disabled:text-muted-foreground disabled:cursor-not-allowed font-medium transition-all shadow-sm"
						>
							{isSubmitting ? 'Submitting...' : 'Submit'}
						</button>
					)}
				</div>
			</div>
		)
	}

	// Multiple questions
	return (
		<div className="bg-gradient-to-br from-amber-50/60 to-orange-50/40 border border-amber-200/40 rounded-2xl p-4">
			<div className="flex items-center justify-between mb-4">
				<div className="flex items-center gap-2">
					<div className="w-5 h-5 rounded-md bg-gradient-to-br from-amber-100 to-orange-100 flex items-center justify-center">
						<svg className="w-3 h-3 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
							<path strokeLinecap="round" strokeLinejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9 5.25h.008v.008H12v-.008z" />
						</svg>
					</div>
					<p className="text-[11px] font-semibold text-amber-700/80 uppercase tracking-wider">
						{questions.length} questions
					</p>
				</div>
				<div className="flex items-center gap-2.5">
					<span className="text-xs text-amber-700/60 tabular-nums font-medium">
						{answeredCount}/{questions.length}
					</span>
					<div className="w-16 h-1.5 bg-amber-200/40 rounded-full overflow-hidden">
						<div
							className="h-full bg-amber-500 rounded-full transition-all duration-300"
							style={{ width: `${(answeredCount / questions.length) * 100}%` }}
						/>
					</div>
				</div>
			</div>

			<div className="space-y-2.5">
				{questions.map((q, index) => (
					<QuestionItem
						key={q.questionId}
						questionId={q.questionId}
						question={q.question}
						inputType={q.inputType}
						draftAnswer={draftAnswers.get(q.questionId)}
						submitStatus={questionSubmitStatus.get(q.questionId) ?? 'idle'}
						onAnswerChange={setDraftAnswer}
						questionNumber={index + 1}
						totalQuestions={questions.length}
					/>
				))}

				<button
					onClick={handleSubmitAll}
					disabled={!allAnswered || isSubmitting}
					className="w-full px-4 py-2.5 bg-foreground text-background text-sm rounded-xl hover:bg-foreground/90 disabled:bg-muted disabled:text-muted-foreground disabled:cursor-not-allowed font-medium transition-all shadow-sm"
				>
					{isSubmitting ? 'Submitting...' : allAnswered ? 'Submit' : `Answer all questions (${answeredCount}/${questions.length})`}
				</button>
			</div>
		</div>
	)
}
