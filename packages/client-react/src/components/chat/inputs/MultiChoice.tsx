import type { AskUserOption } from '@roj-ai/shared'
import { useState } from 'react'

interface MultiChoiceProps {
	options: AskUserOption[]
	minSelect?: number
	maxSelect?: number
	onSubmit: (values: string[]) => void
}

export function MultiChoice({
	options,
	minSelect = 0,
	maxSelect,
	onSubmit,
}: MultiChoiceProps) {
	const [selected, setSelected] = useState<Set<string>>(new Set())

	const toggle = (value: string) => {
		const newSelected = new Set(selected)
		if (newSelected.has(value)) {
			newSelected.delete(value)
		} else {
			if (maxSelect && newSelected.size >= maxSelect) return
			newSelected.add(value)
		}
		setSelected(newSelected)
	}

	const canSubmit = selected.size >= minSelect

	return (
		<div className="space-y-3">
			<div className="space-y-1.5">
				{options.map((option) => {
					const isSelected = selected.has(option.value)
					return (
						<button
							key={option.value}
							onClick={() => toggle(option.value)}
							className={`w-full text-left px-3.5 py-2.5 border rounded-xl text-sm focus:outline-none transition-all ${
								isSelected
									? 'bg-foreground border-foreground text-background'
									: 'bg-background hover:bg-accent/50 border-border'
							}`}
						>
							<div className="flex items-center gap-3">
								<div
									className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors ${
										isSelected
											? 'bg-background border-background'
											: 'border-muted-foreground/30'
									}`}
								>
									{isSelected && (
										<svg className="w-3 h-3 text-foreground" fill="currentColor" viewBox="0 0 12 12">
											<path d="M10.28 2.28L4 8.56 1.72 6.28a1 1 0 00-1.44 1.44l3 3a1 1 0 001.44 0l7-7a1 1 0 00-1.44-1.44z" />
										</svg>
									)}
								</div>
								<div>
									<div className="font-medium">{option.label}</div>
									{option.description && (
										<div className={`text-xs mt-0.5 ${isSelected ? 'text-background/60' : 'text-muted-foreground'}`}>
											{option.description}
										</div>
									)}
								</div>
							</div>
						</button>
					)
				})}
			</div>

			<button
				onClick={() => onSubmit(Array.from(selected))}
				disabled={!canSubmit}
				className="px-4 py-2.5 bg-foreground text-background text-sm rounded-xl hover:bg-foreground/90 disabled:bg-muted disabled:text-muted-foreground disabled:cursor-not-allowed font-medium transition-colors"
			>
				Submit ({selected.size} selected)
			</button>
		</div>
	)
}
