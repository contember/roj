import { useEffect, useRef, useState } from 'react'

interface TextInputProps {
	placeholder?: string
	multiline?: boolean
	// Immediate submit mode (uncontrolled)
	onSubmit?: (value: string) => void
	// Controlled mode for batched answers
	value?: string
	onChange?: (value: string) => void
	showSubmitButton?: boolean
}

export function TextInput({
	placeholder,
	multiline,
	onSubmit,
	value: controlledValue,
	onChange,
	showSubmitButton = true,
}: TextInputProps) {
	const [internalValue, setInternalValue] = useState('')
	const textareaRef = useRef<HTMLTextAreaElement>(null)

	const isControlled = controlledValue !== undefined
	const value = isControlled ? controlledValue : internalValue
	const setValue = isControlled ? onChange : setInternalValue

	// biome-ignore lint/correctness/useExhaustiveDependencies: value triggers resize
	useEffect(() => {
		if (multiline && textareaRef.current) {
			textareaRef.current.style.height = 'auto'
			textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`
		}
	}, [value, multiline])

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault()
		if (!value.trim() || !onSubmit) return
		onSubmit(value.trim())
		if (!isControlled) {
			setInternalValue('')
		}
	}

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === 'Enter' && !e.shiftKey && !multiline && onSubmit) {
			e.preventDefault()
			handleSubmit(e)
		}
	}

	const handleChange = (newValue: string) => {
		if (setValue) {
			setValue(newValue)
		}
	}

	const inputClasses =
		'w-full px-3.5 py-2.5 border border-border rounded-xl text-sm bg-background focus:outline-none focus:border-foreground/20 focus:shadow-sm placeholder:text-muted-foreground/40 transition-all'
	const buttonClasses =
		'px-4 py-2.5 bg-foreground text-background text-sm rounded-xl hover:bg-foreground/90 disabled:bg-muted disabled:text-muted-foreground disabled:cursor-not-allowed font-medium transition-colors'

	// Controlled mode without submit button
	if (isControlled && !showSubmitButton) {
		if (multiline) {
			return (
				<textarea
					ref={textareaRef}
					value={value}
					onChange={(e) => handleChange(e.target.value)}
					placeholder={placeholder ?? 'Type your answer...'}
					rows={3}
					className={`${inputClasses} resize-none`}
				/>
			)
		}

		return (
			<input
				type="text"
				value={value}
				onChange={(e) => handleChange(e.target.value)}
				placeholder={placeholder ?? 'Type your answer...'}
				className={inputClasses}
			/>
		)
	}

	if (multiline) {
		return (
			<form onSubmit={handleSubmit} className="space-y-2">
				<textarea
					ref={textareaRef}
					value={value}
					onChange={(e) => handleChange(e.target.value)}
					placeholder={placeholder ?? 'Type your answer...'}
					rows={3}
					className={`${inputClasses} resize-none`}
				/>
				<button type="submit" disabled={!value.trim()} className={buttonClasses}>
					Submit
				</button>
			</form>
		)
	}

	return (
		<form onSubmit={handleSubmit} className="flex gap-2">
			<input
				type="text"
				value={value}
				onChange={(e) => handleChange(e.target.value)}
				onKeyDown={handleKeyDown}
				placeholder={placeholder ?? 'Type your answer...'}
				className={`flex-1 ${inputClasses}`}
			/>
			<button type="submit" disabled={!value.trim()} className={buttonClasses}>
				Submit
			</button>
		</form>
	)
}
