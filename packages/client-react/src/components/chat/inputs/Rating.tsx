import { useState } from 'react'

interface RatingProps {
	min: number
	max: number
	labels?: { min?: string; max?: string }
	onSelect: (value: number) => void
}

export function Rating({ min, max, labels, onSelect }: RatingProps) {
	const [selected, setSelected] = useState<number | null>(null)
	const range = Array.from({ length: max - min + 1 }, (_, i) => min + i)

	const handleSelect = (value: number) => {
		setSelected(value)
		onSelect(value)
	}

	return (
		<div className="space-y-2">
			{labels && (
				<div className="flex items-center justify-between text-xs text-muted-foreground/60">
					<span>{labels.min ?? min}</span>
					<span>{labels.max ?? max}</span>
				</div>
			)}

			<div className="flex gap-1.5">
				{range.map((value) => (
					<button
						key={value}
						onClick={() => handleSelect(value)}
						className={`flex-1 py-2.5 border rounded-xl text-sm font-medium focus:outline-none transition-all ${
							selected === value
								? 'bg-foreground border-foreground text-background'
								: 'bg-background hover:bg-accent/50 border-border'
						}`}
					>
						{value}
					</button>
				))}
			</div>
		</div>
	)
}
