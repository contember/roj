interface ConfirmProps {
	confirmLabel?: string
	cancelLabel?: string
	onConfirm: () => void
	onCancel: () => void
	value?: boolean
}

export function Confirm({
	confirmLabel = 'Yes',
	cancelLabel = 'No',
	onConfirm,
	onCancel,
	value,
}: ConfirmProps) {
	return (
		<div className="flex gap-2">
			<button
				onClick={onCancel}
				className={`flex-1 px-4 py-2.5 border rounded-xl text-sm font-medium focus:outline-none transition-all ${
					value === false
						? 'bg-foreground border-foreground text-background'
						: 'bg-background hover:bg-accent/50 border-border'
				}`}
			>
				{cancelLabel}
			</button>
			<button
				onClick={onConfirm}
				className={`flex-1 px-4 py-2.5 border rounded-xl text-sm font-medium focus:outline-none transition-all ${
					value === true
						? 'bg-foreground border-foreground text-background'
						: 'bg-background hover:bg-accent/50 border-border'
				}`}
			>
				{confirmLabel}
			</button>
		</div>
	)
}
