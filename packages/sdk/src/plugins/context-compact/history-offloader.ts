import { join } from 'node:path'
import type { AgentId } from '~/core/agents/schema.js'
import type { FileSystem } from '~/platform/fs.js'
import type { HistoryOffloader } from './context-compactor.js'

/**
 * File-based history offloader.
 * Writes conversation history to files in the session directory.
 */
export class FileHistoryOffloader implements HistoryOffloader {
	constructor(
		/** Absolute path to the session directory */
		private readonly sessionDir: string,
		private readonly fs: FileSystem,
	) {}

	async offload(agentId: AgentId, content: string, pathPrefix: string): Promise<string> {
		// pathPrefix is virtual (e.g., /session/.history/)
		// We need to convert it to absolute path
		const relativePath = pathPrefix.replace(/^\/session\/?/, '')
		const absoluteDir = join(this.sessionDir, relativePath, agentId)
		const absolutePath = join(absoluteDir, 'history.md')
		const virtualPath = join(pathPrefix, agentId, 'history.md')

		// Ensure directory exists
		await this.fs.mkdir(absoluteDir, { recursive: true })

		// Format the section with timestamp
		const timestamp = new Date().toISOString()
		const section = `## Summarized at ${timestamp}

${content}

---

`

		// Append to existing file (or create new)
		let existing = ''
		if (await this.fs.exists(absolutePath)) {
			existing = await this.fs.readFile(absolutePath, 'utf-8')
		}
		await this.fs.writeFile(absolutePath, existing + section)

		return virtualPath
	}
}
