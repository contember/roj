import type { ServiceConfig } from '@roj-ai/sdk'
import { ModelId, createOrchestrator, createPreset, defineAgent } from '@roj-ai/sdk'
import { filesystemPlugin } from '@roj-ai/sdk/tools/filesystem'
import { shellPlugin } from '@roj-ai/sdk/tools/shell'

const devService: ServiceConfig = {
	type: 'dev',
	description: 'Development server for previewing the app',
	command: ({ port }) => `bunx serve -l ${port} .`,
	autoStart: true,
	readyPattern: 'Accepting connections',
}

const builder = defineAgent({
	name: 'builder',
	system: `You are a web app builder. You create web applications based on user descriptions.

When asked to build an app:
1. Create the project files in the current directory (index.html, style.css, app.js)
2. The dev server auto-starts — your files are served immediately

Use plain HTML, CSS, and JavaScript. Do NOT use React, npm, or any build tools.
Keep it clean and modern. Always include a complete, working implementation in a single index.html or with separate .css/.js files.`,
	// anthropic/claude-haiku-4.5 works through both providers:
	//   - OpenRouter (fallback): sent as-is
	//   - Anthropic (direct):    normalized to claude-haiku-4-5 (alias of the latest 4.5)
	model: ModelId('anthropic/claude-haiku-4.5'),
	services: [devService],
	plugins: [
		filesystemPlugin.configureAgent({ directoryListing: { maxDepth: 3 } }),
	],
	tools: [],
	agents: [],
})

export const appBuilderPreset = createPreset({
	id: 'app-builder',
	name: 'App Builder',
	workspaceDir: '/tmp/roj-demo/sessions/{sessionId}',
	plugins: [
		shellPlugin.configure({ cwd: '/tmp/roj-demo/sessions' }),
	],
	orchestrator: createOrchestrator({
		...builder,
		agents: [],
	}),
})
