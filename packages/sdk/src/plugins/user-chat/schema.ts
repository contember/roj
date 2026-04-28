import z from 'zod/v4'

export const chatMessageIdSchema = z.string().brand('ChatMessageId')

export type ChatMessageId = z.infer<typeof chatMessageIdSchema>

export const ChatMessageId = (id: string): ChatMessageId => id as ChatMessageId

export const generateChatMessageId = (seq: number): ChatMessageId => ChatMessageId(`m${seq}`)

/**
 * Option for ask_user single/multi choice input types.
 */
export type AskUserOption = {
	value: string
	label: string
	description?: string
}

/**
 * Input type for ask_user tool - defines how the user should respond.
 */
export type AskUserInputType =
	| { type: 'text'; placeholder?: string; multiline?: boolean }
	| { type: 'single_choice'; options: AskUserOption[] }
	| {
		type: 'multi_choice'
		options: AskUserOption[]
		minSelect?: number
		maxSelect?: number
	}
	| { type: 'rating'; min: number; max: number; labels?: { min?: string; max?: string } }
	| { type: 'confirm'; confirmLabel?: string; cancelLabel?: string }

// ============================================================================
// AskUser - Zod schemas
// ============================================================================

export const askUserOptionSchema = z.object({
	value: z.string(),
	label: z.string(),
	description: z.string().optional(),
})

export const askUserInputTypeSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('text'),
		placeholder: z.string().optional(),
		multiline: z.boolean().optional(),
	}),
	z.object({
		type: z.literal('single_choice'),
		options: z.array(askUserOptionSchema).min(1),
	}),
	z.object({
		type: z.literal('multi_choice'),
		options: z.array(askUserOptionSchema).min(1),
		minSelect: z.number().int().min(0).optional(),
		maxSelect: z.number().int().min(1).optional(),
	}),
	z.object({
		type: z.literal('rating'),
		min: z.number().int(),
		max: z.number().int(),
		labels: z
			.object({
				min: z.string().optional(),
				max: z.string().optional(),
			})
			.optional(),
	}),
	z.object({
		type: z.literal('confirm'),
		confirmLabel: z.string().optional(),
		cancelLabel: z.string().optional(),
	}),
])

export type AskUserInputTypeSchema = z.infer<typeof askUserInputTypeSchema>
export type AskUserOptionInput = z.infer<typeof askUserOptionSchema>
