/** The app the e2e host loads, built the way `roj build` builds an externalSdk bundle. */

import { createOrchestrator, createPreset, definePlugin, ModelId, Ok, z } from '@roj-ai/sdk'
import { defineConfig } from '@roj-ai/sdk/user-config'

const probe = definePlugin('probe')
	.method('whoami', {
		input: z.object({ sessionId: z.string() }),
		output: z.object({ source: z.string() }),
		handler: async ctx => Ok({ source: ctx.caller.source }),
	})
	.build()

export default defineConfig({
	presets: [
		createPreset({
			id: 'app',
			name: 'App',
			plugins: [probe.configure()],
			orchestrator: createOrchestrator({ system: 'Answer briefly.', model: ModelId('test/model'), plugins: [], tools: [], agents: [] }),
		}),
	],
})
