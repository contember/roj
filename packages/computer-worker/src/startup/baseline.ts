/** Startup floor: what wrangler's own middleware costs before any import of ours. */

export default {
	fetch(): Response {
		return Response.json({ probe: 'baseline' })
	},
} satisfies ExportedHandler
