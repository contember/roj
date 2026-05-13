import type { AskUserInputType } from '@roj-ai/shared'
import { useRef, useState } from 'react'
import { type QuestionSubmitStatus, useSessionStore } from '../../stores/session-store.js'
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
		case 'text': {
			const allowAttachments = inputType?.type === 'text' && inputType.allowAttachments === true
			return (
				<div className="space-y-2">
					<TextInput
						placeholder={inputType?.type === 'text' ? inputType.placeholder : undefined}
						value={(currentValue as string) ?? ''}
						onChange={(val) => onChange(val)}
						showSubmitButton={false}
					/>
					{allowAttachments && <QuestionAttachments />}
				</div>
			)
		}

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

// Inline upload control rendered next to a text answer when the agent set
// `allowAttachments: true` on the ask_user input. Reuses the session-level
// `pendingAttachments` pool, so dropped files are submitted to the session
// (and surfaced to the agent) automatically when the user submits the
// questionnaire. The pool is shared across all questions/messages — staging
// a file here is equivalent to dropping it into the main chat composer.
function QuestionAttachments() {
	const pendingAttachments = useSessionStore((s) => s.pendingAttachments)
	const uploadFile = useSessionStore((s) => s.uploadFile)
	const removeAttachment = useSessionStore((s) => s.removeAttachment)
	const fileInputRef = useRef<HTMLInputElement>(null)
	const [dragging, setDragging] = useState(false)

	const attachments = Array.from(pendingAttachments.values())

	const handleFiles = async (files: FileList | null) => {
		if (!files) return
		for (const file of Array.from(files)) {
			await uploadFile(file)
		}
	}

	return (
		<div
			onDragOver={(e) => {
				e.preventDefault()
				setDragging(true)
			}}
			onDragLeave={() => setDragging(false)}
			onDrop={(e) => {
				e.preventDefault()
				setDragging(false)
				handleFiles(e.dataTransfer.files)
			}}
			className={`rounded-lg border border-dashed px-3 py-2 transition-colors ${
				dragging
					? 'border-violet-400 bg-violet-50/60'
					: 'border-border bg-background hover:bg-accent/30'
			}`}
		>
			<div className="flex items-center justify-between gap-2">
				<button
					type="button"
					onClick={() => fileInputRef.current?.click()}
					className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
				>
					<svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
						<path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
					</svg>
					<span>Attach file (or drop here)</span>
				</button>
				{attachments.length > 0 && (
					<span className="text-[10px] text-muted-foreground/70 tabular-nums">
						{attachments.filter((a) => a.status === 'ready').length}/{attachments.length} ready
					</span>
				)}
			</div>
			<input
				ref={fileInputRef}
				type="file"
				multiple
				onChange={(e) => {
					handleFiles(e.target.files)
					e.target.value = ''
				}}
				className="hidden"
			/>
			{attachments.length > 0 && (
				<ul className="mt-2 space-y-1">
					{attachments.map((a) => (
						<li key={a.uploadId} className="flex items-center gap-2 text-xs">
							<span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
								a.status === 'ready'
									? 'bg-emerald-400'
									: a.status === 'failed'
									? 'bg-red-400'
									: 'bg-amber-400 animate-pulse'
							}`} />
							<span className="truncate flex-1">{a.filename}</span>
							<span className="text-[10px] text-muted-foreground/60 shrink-0">
								{a.status === 'ready' ? 'ready' : a.status === 'failed' ? (a.error ?? 'failed') : a.status}
							</span>
							<button
								type="button"
								onClick={() => removeAttachment(a.uploadId)}
								className="text-muted-foreground/60 hover:text-foreground transition-colors"
								aria-label={`Remove ${a.filename}`}
							>
								<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
									<path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
								</svg>
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	)
}
