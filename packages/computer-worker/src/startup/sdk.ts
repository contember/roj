/** Startup cost of the SDK alone — plugin registry and zod schemas, no platform. */

import { bootstrap, createSystemFromServices, fullPlugins, isolatePlugins } from '@roj-ai/sdk'

export default {
	fetch(): Response {
		// Referenced so esbuild keeps the imports; never called.
		const kept = [bootstrap, createSystemFromServices].map((fn) => fn.name)
		return Response.json({ probe: 'sdk', kept, full: fullPlugins.length, isolate: isolatePlugins.length })
	},
} satisfies ExportedHandler
