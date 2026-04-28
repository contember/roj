import z4 from 'zod/v4'
import { createEventsFactory } from '~/core/events/types'

export const resourceEvents = createEventsFactory({
	events: {
		resource_injected: z4.object({
			resourceId: z4.string(),
			slug: z4.string().optional(),
			name: z4.string().optional(),
			filename: z4.string(),
			mimeType: z4.string(),
			paths: z4.array(z4.string()),
			injectedAt: z4.number(),
		}),
	},
})

export interface InjectedResource {
	resourceId: string
	slug?: string
	name?: string
	filename: string
	mimeType: string
	paths: string[]
	injectedAt: number
}

export interface ResourcesState {
	resources: InjectedResource[]
}
