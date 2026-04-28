import type { AskUserOption } from '@roj-ai/shared'

interface SingleChoiceProps {
	options: AskUserOption[]
	onSelect: (value: string) => void
	selectedValue?: string
}

export function SingleChoice({ options, onSelect, selectedValue }: SingleChoiceProps) {
	return (
		<div className="space-y-1.5">
			{options.map((option) => {
				const isSelected = selectedValue === option.value
				return (
					<button
						key={option.value}
						onClick={() => onSelect(option.value)}
						className={`w-full text-left px-3.5 py-2.5 border rounded-xl text-sm focus:outline-none transition-all ${
							isSelected
								? 'bg-foreground border-foreground text-background'
								: 'bg-background hover:bg-accent/50 border-border'
						}`}
					>
						<div className="flex items-center gap-3">
							<div
								className={`w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-colors ${
									isSelected
										? 'border-background'
										: 'border-muted-foreground/30'
								}`}
							>
								{isSelected && <div className="w-2 h-2 rounded-full bg-background" />}
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
	)
}
