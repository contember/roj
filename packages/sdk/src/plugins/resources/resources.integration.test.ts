import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockLLMProvider } from '~/core/llm/mock.js'
import { createTestPreset, TestHarness } from '~/testing/index.js'
import { resourcesPlugin } from './plugin.js'
import { resourceEvents, type ResourcesState } from './state.js'

let currentHarness: TestHarness | undefined

afterEach(async () => {
	if (currentHarness) {
		await currentHarness.shutdown()
		currentHarness = undefined
	}
})

describe('resources plugin', () => {
	it('resolves targetDir callback relative to workspace and records it in state', async () => {
		const workspaceDir = await mkdtemp(join(tmpdir(), 'roj-resources-'))
		const targetDir = join(workspaceDir, 'packages', 'web')

		try {
			const harness = new TestHarness({
				presets: [
					createTestPreset({
						workspaceDir,
						plugins: [
							resourcesPlugin.configure({
								targetDir: ({ sessionId, workspaceDir: resolvedWorkspaceDir }) => {
									expect(sessionId.length).toBeGreaterThan(0)
									expect(resolvedWorkspaceDir).toBe(workspaceDir)
									return 'packages/web'
								},
							}),
						],
					}),
				],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})
			currentHarness = harness

			const session = await harness.createSession('test')
			const result = await session.callPluginMethod('resources.inject', {
				sessionId: String(session.sessionId),
				filename: 'hello.txt',
				mimeType: 'text/plain',
				size: 5,
				fileBuffer: Buffer.from('hello'),
			})

			expect(result).toMatchObject({
				ok: true,
				value: { paths: ['hello.txt'] },
			})
			await expect(readFile(join(targetDir, 'hello.txt'), 'utf-8')).resolves.toBe('hello')

			const resources = session.getPluginState<ResourcesState>('resources')
			expect(resources?.resources[0]?.targetDir).toBe(targetDir)

			const events = await session.getEventsByType(resourceEvents, 'resource_injected')
			expect(events[0]?.targetDir).toBe(targetDir)
		} finally {
			await rm(workspaceDir, { recursive: true, force: true })
		}
	})
})
