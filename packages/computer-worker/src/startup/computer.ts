/** Startup cost of the filesystem platform alone — computer plus its just-bash shell. */

import { Workspace } from '@cloudflare/computer'
import { WorkerShellBackend } from '@cloudflare/computer/backends/worker-shell'
import { createGitClient } from '@cloudflare/computer/git'

export default {
	fetch(): Response {
		// Referenced so esbuild keeps the imports; never called.
		const kept = [Workspace.name, WorkerShellBackend.name, createGitClient.name]
		return Response.json({ probe: 'computer', kept })
	},
} satisfies ExportedHandler
