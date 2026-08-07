/**
 * Two-agent preset for the isolate harness.
 *
 * The orchestrator spawns a `writer` sub-agent, which writes a file through the
 * filesystem plugin — exercising agent spawn, the mailbox, tool execution and
 * the workspace-backed filesystem in one run.
 */

import { ModelId, createOrchestrator, createPreset, defineAgent } from '@roj-ai/sdk'
import { filesystemPlugin } from '@roj-ai/sdk/tools/filesystem'

const writer = defineAgent({
	name: 'writer',
	system: 'You write files into the workspace using write_file.',
	model: ModelId('mock/model'),
	plugins: [filesystemPlugin.configureAgent({ directoryListing: { maxDepth: 3 } })],
	tools: [],
	agents: [],
})

export const isolatePreset = createPreset({
	id: 'isolate-smoke',
	name: 'Isolate smoke test',
	workspaceDir: '/workspace/{sessionId}',
	// Non-sandboxed mode resolves relative agent paths against process.cwd(),
	// which a Worker isolate does not meaningfully have.
	sandboxed: true,
	orchestrator: createOrchestrator({
		system: 'You delegate file writing to the writer agent via start_writer.',
		model: ModelId('mock/model'),
		plugins: [filesystemPlugin.configureAgent({ directoryListing: { maxDepth: 3 } })],
		tools: [],
		agents: [writer],
	}),
})
