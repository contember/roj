import { expect, test } from 'bun:test'
import { createGit, Workspace } from '@kompjutr/do'
import { MemoryEventStore } from '../../sdk/src/core/events/memory.js'
import { SessionFileStore } from '../../sdk/src/core/file-store/file-store.js'
import { MockLLMProvider } from '../../sdk/src/core/llm/mock.js'
import { SessionManager } from '../../sdk/src/core/sessions/session-manager.js'
import { ToolExecutor } from '../../sdk/src/core/tools/executor.js'
import { silentLogger } from '../../sdk/src/lib/logger/logger.js'
import { gitStatusPlugin } from '../../sdk/src/plugins/git-status/plugin.js'
import { createTestPreset } from '../../sdk/src/testing/preset-helpers.js'
import { createKompjutrPlatform } from './index.js'
import { BunSqliteStorage } from './testing/storage.js'

test('git-status refresh observes direct Git add and commit with no filesystem mutation', async () => {
	const storage = new BunSqliteStorage()
	const workspace = new Workspace({
		storage,
		git: createGit(),
		defaultGitIdentity: { name: 'Test', email: 'test@example.com' },
	})
	const platform = createKompjutrPlatform(workspace, { scheduler: { wake: async () => {}, cancel: async () => {} } })
	const preset = createTestPreset({ id: 'git-refresh', workspaceDir: '/repo' })
	const manager = new SessionManager({
		eventStore: new MemoryEventStore(),
		llmProvider: MockLLMProvider.withFixedResponse({ content: 'ok', toolCalls: [] }),
		toolExecutor: new ToolExecutor(silentLogger),
		presets: new Map([[preset.id, preset]]),
		logger: silentLogger,
		basePath: '/data',
		dataFileStore: new SessionFileStore('/data', undefined, false, platform.fs, 'session'),
		platform,
		systemPlugins: [gitStatusPlugin],
	})
	try {
		expect(platform.fsRevision).toBeUndefined()
		await platform.fs.mkdir('/repo')
		await workspace.git.init({ dir: '/repo', defaultBranch: 'main' })
		await platform.fs.writeFile('/repo/note', 'initial')
		await workspace.git.add({ dir: '/repo', paths: ['note'] })
		await workspace.git.commit({ dir: '/repo', message: 'initial' })
		await workspace.git.branch({ dir: '/repo', name: 'feature', checkout: true })
		await platform.fs.writeFile('/repo/note', 'changed')
		const created = await manager.createSession(preset.id)
		if (!created.ok) throw new Error(created.error.message)
		const session = created.value
		expect(await session.callPluginMethod('git-status.refresh', {})).toMatchObject({
			ok: true,
			value: { snapshot: { committedAhead: 0, uncommittedFiles: 1, lastCommitMessage: 'initial' } },
		})
		const revision = workspace.filesystem.rev()
		await workspace.git.add({ dir: '/repo', paths: ['note'] })
		await workspace.git.commit({ dir: '/repo', message: 'committed without a filesystem write' })
		expect(workspace.filesystem.rev()).toBe(revision)
		expect(await session.callPluginMethod('git-status.refresh', {})).toMatchObject({
			ok: true,
			value: { snapshot: { committedAhead: 1, uncommittedFiles: 0, lastCommitMessage: 'committed without a filesystem write' } },
		})
	} finally {
		await manager.shutdown()
		storage.close()
	}
})
