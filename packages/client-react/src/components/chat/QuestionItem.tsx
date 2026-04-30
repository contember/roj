import type { AskUserInputType } from '@roj-ai/shared'
import { useState } from 'react'
import type { QuestionSubmitStatus } from '../../stores/session-store.js'
import { Confirm } from './inputs/Confirm.js'
import { MultiChoice } from './inputs/MultiChoice.js'
import { Rating } from './inputs/Rating.js'
import { SingleChoice } from './inputs/SingleChoice.js'
import { TextInput } from './inputs/TextInput.js'

interface QuestionItemProps {
	questionId: string
	question: string
	inputType: AskUserInputType | undefined
	draftAnswer: unknown
	submitStatus: QuestionSubmitStatus
	onAnswerChange: (questionId: string, value: unknown) => void
	questionNumber: number
	totalQuestions: number
}

export function QuestionItem({
	questionId,
	question,
	inputType,
	draftAnswer,
	submitStatus,
	onAnswerChange,
	questionNumber,
	totalQuestions,
}: QuestionItemProps) {
	const [showCustomText, setShowCustomText] = useState(false)
	const isSkipped = draftAnswer === '[skipped]'
	const isAnswered = draftAnswer !== undefined
	const isSubmitting = submitStatus === 'submitting'
	const hasError = submitStatus === 'error'
	const isTextInput = (inputType?.type ?? 'text') === 'text'

	return (
		<div
			className={`p-3.5 rounded-xl border transition-all ${
				hasError
					? 'border-red-200 bg-red-50/50'
					: isAnswered
					? 'border-emerald-200/80 bg-emerald-50/40'
					: 'border-border bg-background'
			} ${isSubmitting ? 'opacity-50' : ''}`}
		>
			<div className="flex items-start gap-3">
				<div
					className={`flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium transition-all ${
						isAnswered
							? 'bg-emerald-500 text-white'
							: 'bg-accent text-muted-foreground'
					}`}
				>
					{isAnswered
						? (
							<svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 12 12">
								<path d="M10.28 2.28L4 8.56 1.72 6.28a1 1 0 00-1.44 1.44l3 3a1 1 0 001.44 0l7-7a1 1 0 00-1.44-1.44z" />
							</svg>
						)
						: questionNumber}
				</div>
				<div className="flex-1 min-w-0">
					<div className="flex items-center gap-2 mb-2.5">
						<p className="text-sm font-medium">{question}</p>
						{totalQuestions > 1 && (
							<span className="text-[10px] text-muted-foreground/60 tabular-nums shrink-0">
								{questionNumber}/{totalQuestions}
							</span>
						)}
					</div>

					{hasError && (
						<div className="text-xs text-red-500 mb-2">
							Failed to submit. Please try again.
						</div>
					)}

					{isSkipped
						? (
							<div className="flex items-center gap-2">
								<span className="inline-flex items-center px-2.5 py-1 rounded-lg bg-accent text-xs font-medium text-muted-foreground">
									Skipped
								</span>
								<button
									type="button"
									onClick={() => onAnswerChange(questionId, undefined as unknown)}
									className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors"
								>
									Back to answer
								</button>
							</div>
						)
						: showCustomText
						? (
							<div className="space-y-2">
								<TextInput
									placeholder="Type your custom answer..."
									value={(draftAnswer as string) ?? ''}
									onChange={(val) => onAnswerChange(questionId, val)}
									showSubmitButton={false}
								/>
								<button
									type="button"
									onClick={() => {
										setShowCustomText(false)
										onAnswerChange(questionId, undefined as unknown)
									}}
									className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors"
								>
									Back to options
								</button>
							</div>
						)
						: (
							<>
								{renderInput(inputType, draftAnswer, (value) => onAnswerChange(questionId, value))}
								<div className="flex items-center gap-3 mt-2.5">
									{!isTextInput && (
										<button
											type="button"
											onClick={() => setShowCustomText(true)}
											className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors"
										>
											Write custom answer
										</button>
									)}
									<button
										type="button"
										onClick={() => onAnswerChange(questionId, '[skipped]')}
										className="px-3 py-1.5 text-xs font-medium text-muted-foreground bg-accent hover:bg-accent/80 rounded-lg transition-colors"
									>
										Skip
									</button>
								</div>
							</>
						)}
				</div>
			</div>
		</div>
	)
}

function renderInput(
	inputType: AskUserInputType | undefined,
	currentValue: unknown,
	onChange: (value: unknown) => void,
) {
	const type = inputType?.type ?? 'text'
	switch (type) {
		case 'text':
			return (
				<TextInput
					placeholder={inputType?.type === 'text' ? inputType.placeholder : undefined}
					value={(currentValue as string) ?? ''}
					onChange={(val) => onChange(val)}
					showSubmitButton={false}
				/>
			)

		case 'single_choice':
			return (
				<SingleChoice
					options={inputType?.type === 'single_choice' ? inputType.options : []}
					onSelect={onChange}
					selectedValue={currentValue as string | undefined}
				/>
			)

		case 'multi_choice':
			return (
				<MultiChoice
					options={inputType?.type === 'multi_choice' ? inputType.options : []}
					minSelect={inputType?.type === 'multi_choice' ? inputType.minSelect : undefined}
					maxSelect={inputType?.type === 'multi_choice' ? inputType.maxSelect : undefined}
					onSubmit={onChange}
				/>
			)

		case 'rating':
			return (
				<Rating
					min={inputType?.type === 'rating' ? inputType.min : 1}
					max={inputType?.type === 'rating' ? inputType.max : 5}
					labels={inputType?.type === 'rating' ? inputType.labels : undefined}
					onSelect={onChange}
				/>
			)

		case 'confirm':
			return (
				<Confirm
					confirmLabel={inputType?.type === 'confirm' ? inputType.confirmLabel : undefined}
					cancelLabel={inputType?.type === 'confirm' ? inputType.cancelLabel : undefined}
					onConfirm={() => onChange(true)}
					onCancel={() => onChange(false)}
					value={currentValue as boolean | undefined}
				/>
			)
	}
}
