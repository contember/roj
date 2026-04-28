import z from 'zod/v4'
import type { PostInjectRule } from './post-inject.js'

/**
 * File at the root of a resource zip that ships template-specific setup
 * instructions (e.g. `bun install` for a JS template). Read by the resources
 * plugin after extraction, then deleted so it doesn't pollute the workspace.
 */
export const RESOURCE_MANIFEST_FILENAME = 'roj.resource.json'

const PostInjectRuleSchema = z.object({
	name: z.string().optional(),
	when: z.string().optional(),
	cwd: z.enum(['target', 'session']).optional(),
	run: z.tuple([z.string()]).rest(z.string()),
	env: z.record(z.string(), z.string()).optional(),
	timeoutMs: z.number().positive().optional(),
	continueOnError: z.boolean().optional(),
}) satisfies z.ZodType<PostInjectRule>

export const ResourceManifestSchema = z.object({
	postInject: z.array(PostInjectRuleSchema).optional(),
})

export type ResourceManifest = z.infer<typeof ResourceManifestSchema>
