import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { contentToString } from '~/core/llm/llm-log-types.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { createTestPreset, TestHarness } from '~/testing/index.js'
import { filesystemPlugin } from './index.js'
import type { FilesystemPresetConfig } from './plugin.js'

// ============================================================================
// Test fixtures
// ============================================================================

let fixtureDir: string

beforeAll(() => {
	fixtureDir = `/tmp/roj-fs-test-${Math.random().toString(36).slice(2)}`
	fs.mkdirSync(fixtureDir, { recursive: true })

	// Create test files
	fs.writeFileSync(path.join(fixtureDir, 'hello.txt'), 'Hello, world!')
	fs.writeFileSync(path.join(fixtureDir, 'multiline.txt'), Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`).join('\n'))

	// Create subdirectory with files
	fs.mkdirSync(path.join(fixtureDir, 'subdir'), { recursive: true })
	fs.writeFileSync(path.join(fixtureDir, 'subdir', 'nested.txt'), 'Nested content')

	// Create a denied path directory
	fs.mkdirSync(path.join(fixtureDir, '.events'), { recursive: true })
	fs.writeFileSync(path.join(fixtureDir, '.events', 'secret.txt'), 'Should not be accessible')
})

afterAll(() => {
	fs.rmSync(fixtureDir, { recursive: true, force: true })
})

// ============================================================================
// Helpers
// ============================================================================

function createFsPreset(pluginConfig?: Partial<FilesystemPresetConfig>, overrides?: Parameters<typeof createTestPreset>[0]) {
	const preset = createTestPreset({
		...overrides,
		plugins: [
			filesystemPlugin.configure({
				deniedPaths: ['.events'],
				...pluginConfig,
			}),
			...(overrides?.plugins ?? []),
		],
	})
	// Set workspaceDir so file paths within fixtureDir are allowed
	preset.workspaceDir = fixtureDir
	return preset
}

function createFsHarness(options: Omit<ConstructorParameters<typeof TestHarness>[0], 'systemPlugins'>) {
	return new TestHarness(options)
}

// ============================================================================
// Tests
// ============================================================================

describe('filesystem plugin', () => {
	// =========================================================================
	// read_file tool
	// =========================================================================

	describe('read_file tool', () => {
		it('read existing file → correct content', async () => {
			const filePath = path.join(fixtureDir, 'hello.txt')
			const harness = createFsHarness({
				presets: [createFsPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'read_file',
							input: { path: filePath },
						}],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Read file')

			const callHistory = harness.llmProvider.getCallHistory()
			expect(callHistory).toHaveLength(2)
			const toolMessages = callHistory[1].messages.filter((m) => m.role === 'tool')
			expect(toolMessages).toHaveLength(1)
			const result = JSON.parse(contentToString(toolMessages[0].content))
			expect(result.content).toBe('Hello, world!')

			await harness.shutdown()
		})

		it('read with offset and maxLines → correct slice', async () => {
			const filePath = path.join(fixtureDir, 'multiline.txt')
			const harness = createFsHarness({
				presets: [createFsPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'read_file',
							input: { path: filePath, offset: 2, maxLines: 3 },
						}],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Read file')

			const callHistory = harness.llmProvider.getCallHistory()
			const toolMessages = callHistory[1].messages.filter((m) => m.role === 'tool')
			const result = JSON.parse(contentToString(toolMessages[0].content))
			expect(result.content).toBe('Line 3\nLine 4\nLine 5')
			expect(result.totalLines).toBe(20)

			await harness.shutdown()
		})

		it('read non-existent file → error', async () => {
			const filePath = path.join(fixtureDir, 'does-not-exist.txt')
			const harness = createFsHarness({
				presets: [createFsPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'read_file',
							input: { path: filePath },
						}],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Read file')

			const callHistory = harness.llmProvider.getCallHistory()
			const toolMessages = callHistory[1].messages.filter((m) => m.role === 'tool')
			expect(toolMessages).toHaveLength(1)
			const content = toolMessages[0].content
			expect(content).toContain('Not found')

			await harness.shutdown()
		})

		it('read a directory path → "is not a file" error', async () => {
			const dirPath = path.join(fixtureDir, 'subdir')
			const harness = createFsHarness({
				presets: [createFsPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'read_file',
							input: { path: dirPath },
						}],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Read file')

			const callHistory = harness.llmProvider.getCallHistory()
			const toolMessages = callHistory[1].messages.filter((m) => m.role === 'tool')
			const content = toolMessages[0].content
			expect(content).toContain('is not a file')

			await harness.shutdown()
		})
	})

	// =========================================================================
	// write_file tool
	// =========================================================================

	describe('write_file tool', () => {
		it('write file → file created with correct content', async () => {
			const filePath = path.join(fixtureDir, 'written.txt')
			const harness = createFsHarness({
				presets: [createFsPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'write_file',
							input: { path: filePath, content: 'Written content' },
						}],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Write file')

			const content = fs.readFileSync(filePath, 'utf-8')
			expect(content).toBe('Written content')

			fs.unlinkSync(filePath)
			await harness.shutdown()
		})

		it('write to nested path → parent directories created', async () => {
			const filePath = path.join(fixtureDir, 'new-dir', 'deep', 'file.txt')
			const harness = createFsHarness({
				presets: [createFsPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'write_file',
							input: { path: filePath, content: 'Deep content' },
						}],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Write file')

			const content = fs.readFileSync(filePath, 'utf-8')
			expect(content).toBe('Deep content')

			fs.rmSync(path.join(fixtureDir, 'new-dir'), { recursive: true })
			await harness.shutdown()
		})

		it('write to denied path → access denied', async () => {
			const filePath = path.join(fixtureDir, '.events', 'blocked.txt')
			const harness = createFsHarness({
				presets: [createFsPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'write_file',
							input: { path: filePath, content: 'Should fail' },
						}],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Write file')

			const callHistory = harness.llmProvider.getCallHistory()
			const toolMessages = callHistory[1].messages.filter((m) => m.role === 'tool')
			const content = toolMessages[0].content
			expect(content).toContain('denied')

			await harness.shutdown()
		})
	})

	// =========================================================================
	// list_directory tool
	// =========================================================================

	describe('list_directory tool', () => {
		it('list directory → returns files and subdirectories', async () => {
			const harness = createFsHarness({
				presets: [createFsPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'list_directory',
							input: { path: fixtureDir, includeHidden: false },
						}],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('List dir')

			const callHistory = harness.llmProvider.getCallHistory()
			const toolMessages = callHistory[1].messages.filter((m) => m.role === 'tool')
			const content = toolMessages[0].content
			expect(content).toContain('hello.txt')
			expect(content).toContain('subdir')

			await harness.shutdown()
		})

		it('recursive: true → nested entries included', async () => {
			const harness = createFsHarness({
				presets: [createFsPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'list_directory',
							input: { path: fixtureDir, recursive: true, includeHidden: false },
						}],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('List dir')

			const callHistory = harness.llmProvider.getCallHistory()
			const toolMessages = callHistory[1].messages.filter((m) => m.role === 'tool')
			const content = toolMessages[0].content
			expect(content).toContain('nested.txt')

			await harness.shutdown()
		})

		it('list non-existent path → error', async () => {
			const dirPath = path.join(fixtureDir, 'nonexistent-dir')
			const harness = createFsHarness({
				presets: [createFsPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'list_directory',
							input: { path: dirPath },
						}],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('List dir')

			const callHistory = harness.llmProvider.getCallHistory()
			const toolMessages = callHistory[1].messages.filter((m) => m.role === 'tool')
			const content = toolMessages[0].content
			expect(content).toContain('Not found')

			await harness.shutdown()
		})

		it('list file path → "is not a directory" error', async () => {
			const filePath = path.join(fixtureDir, 'hello.txt')
			const harness = createFsHarness({
				presets: [createFsPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'list_directory',
							input: { path: filePath },
						}],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('List dir')

			const callHistory = harness.llmProvider.getCallHistory()
			const toolMessages = callHistory[1].messages.filter((m) => m.role === 'tool')
			const content = toolMessages[0].content
			expect(content).toContain('is not a directory')

			await harness.shutdown()
		})
	})

	// =========================================================================
	// Auto-truncation
	// =========================================================================

	describe('auto-truncation', () => {
		it('large file without explicit range → auto-truncated with head+tail', async () => {
			const largeFilePath = path.join(fixtureDir, 'large.txt')
			const lines = Array.from({ length: 1000 }, (_, i) => `Line ${i + 1}: ${'x'.repeat(100)}`)
			fs.writeFileSync(largeFilePath, lines.join('\n'))

			const harness = createFsHarness({
				presets: [createFsPreset({
					maxTokens: 100,
				})],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'read_file',
							input: { path: largeFilePath },
						}],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Read file')

			const callHistory = harness.llmProvider.getCallHistory()
			const toolMessages = callHistory[1].messages.filter((m) => m.role === 'tool')
			const result = JSON.parse(contentToString(toolMessages[0].content))
			expect(result.truncated).toBe(true)
			expect(result.content).toContain('truncated')
			expect(result.content).toContain('Line 1:')
			expect(result.totalLines).toBe(1000)

			fs.unlinkSync(largeFilePath)
			await harness.shutdown()
		})
	})

	// =========================================================================
	// Denied paths
	// =========================================================================

	describe('denied paths', () => {
		it('read in denied path → access denied', async () => {
			const filePath = path.join(fixtureDir, '.events', 'secret.txt')
			const harness = createFsHarness({
				presets: [createFsPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'read_file',
							input: { path: filePath },
						}],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Read file')

			const callHistory = harness.llmProvider.getCallHistory()
			const toolMessages = callHistory[1].messages.filter((m) => m.role === 'tool')
			const content = toolMessages[0].content
			expect(content).toContain('denied')

			await harness.shutdown()
		})
	})

	// =========================================================================
	// Disabled
	// =========================================================================

	describe('disabled', () => {
		it('enabled: false at agent level → no filesystem tools', async () => {
			const harness = createFsHarness({
				presets: [createFsPreset(undefined, {
					orchestratorPlugins: [
						filesystemPlugin.configureAgent({ enabled: false }),
					],
				})],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			const lastRequest = harness.llmProvider.getLastRequest()
			const toolNames = lastRequest?.tools?.map((t) => t.name) ?? []
			expect(toolNames).not.toContain('read_file')
			expect(toolNames).not.toContain('write_file')
			expect(toolNames).not.toContain('list_directory')

			await harness.shutdown()
		})
	})
})
