import { describe, expect, it } from 'bun:test'
import { contentToString } from '~/core/llm/llm-log-types.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { createTestPreset, TestHarness } from '~/testing/index.js'
import { shellPlugin } from './index.js'

// ============================================================================
// Helpers
// ============================================================================

function createShellPreset(overrides?: Parameters<typeof createTestPreset>[0] & { shellConfig?: Partial<import('./plugin.js').ShellPresetConfig> }) {
	const { shellConfig, ...rest } = overrides ?? {}
	return createTestPreset({
		...rest,
		plugins: [
			shellPlugin.configure({
				cwd: '/tmp',
				sandboxed: false,
				timeout: 30000,
				...shellConfig,
			}),
			...(rest?.plugins ?? []),
		],
	})
}

function createShellHarness(options: Omit<ConstructorParameters<typeof TestHarness>[0], 'systemPlugins'>) {
	return new TestHarness({ ...options, systemPlugins: [shellPlugin] })
}

// ============================================================================
// Tests
// ============================================================================

describe('shell plugin', () => {
	// =========================================================================
	// run_command tool
	// =========================================================================

	describe('run_command tool', () => {
		it('echo hello → stdout contains "hello", exitCode 0', async () => {
			const harness = createShellHarness({
				presets: [createShellPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'run_command',
							input: { command: 'echo hello' },
						}],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Run command')

			const callHistory = harness.llmProvider.getCallHistory()
			const toolMessages = callHistory[1].messages.filter((m) => m.role === 'tool')
			const result = JSON.parse(contentToString(toolMessages[0].content))
			expect(result.stdout).toContain('hello')
			expect(result.exitCode).toBe(0)

			await harness.shutdown()
		})

		it('command with exit code 1 → exitCode 1', async () => {
			const harness = createShellHarness({
				presets: [createShellPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'run_command',
							input: { command: 'false' },
						}],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Run command')

			const callHistory = harness.llmProvider.getCallHistory()
			const toolMessages = callHistory[1].messages.filter((m) => m.role === 'tool')
			const result = JSON.parse(contentToString(toolMessages[0].content))
			expect(result.exitCode).toBe(1)

			await harness.shutdown()
		})

		it('command with stderr → stderr captured', async () => {
			const harness = createShellHarness({
				presets: [createShellPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'run_command',
							input: { command: 'echo error_output >&2' },
						}],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Run command')

			const callHistory = harness.llmProvider.getCallHistory()
			const toolMessages = callHistory[1].messages.filter((m) => m.role === 'tool')
			const result = JSON.parse(contentToString(toolMessages[0].content))
			expect(result.stderr).toContain('error_output')

			await harness.shutdown()
		})

		it('command with stdin → stdin delivered', async () => {
			const harness = createShellHarness({
				presets: [createShellPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'run_command',
							input: { command: 'cat', stdin: 'stdin_content' },
						}],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Run command')

			const callHistory = harness.llmProvider.getCallHistory()
			const toolMessages = callHistory[1].messages.filter((m) => m.role === 'tool')
			const result = JSON.parse(contentToString(toolMessages[0].content))
			expect(result.stdout).toContain('stdin_content')

			await harness.shutdown()
		})

		it('command with env vars → env vars available', async () => {
			const harness = createShellHarness({
				presets: [createShellPreset({
					shellConfig: {
						env: { TEST_VAR: 'test_value_123' },
					},
				})],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'run_command',
							input: { command: 'echo $TEST_VAR' },
						}],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Run command')

			const callHistory = harness.llmProvider.getCallHistory()
			const toolMessages = callHistory[1].messages.filter((m) => m.role === 'tool')
			const result = JSON.parse(contentToString(toolMessages[0].content))
			expect(result.stdout).toContain('test_value_123')

			await harness.shutdown()
		})
	})

	// =========================================================================
	// Timeout
	// =========================================================================

	describe('timeout', () => {
		it('slow command with short timeout → timedOut: true', async () => {
			const harness = createShellHarness({
				presets: [createShellPreset({
					shellConfig: { timeout: 500 },
				})],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'run_command',
							input: { command: 'sleep 10', timeout: 500 },
						}],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Run command', { timeoutMs: 15000 })

			const callHistory = harness.llmProvider.getCallHistory()
			const toolMessages = callHistory[1].messages.filter((m) => m.role === 'tool')
			const result = JSON.parse(contentToString(toolMessages[0].content))
			expect(result.timedOut).toBe(true)

			await harness.shutdown()
		})
	})

	// =========================================================================
	// Working directory
	// =========================================================================

	describe('working directory', () => {
		it('pwd with custom cwd → output matches cwd', async () => {
			const harness = createShellHarness({
				presets: [createShellPreset({
					shellConfig: { cwd: '/tmp' },
				})],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'run_command',
							input: { command: 'pwd' },
						}],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Run command')

			const callHistory = harness.llmProvider.getCallHistory()
			const toolMessages = callHistory[1].messages.filter((m) => m.role === 'tool')
			const result = JSON.parse(contentToString(toolMessages[0].content))
			// /tmp may resolve to a different path on some systems
			expect(result.stdout.trim()).toMatch(/tmp/)

			await harness.shutdown()
		})
	})

	// =========================================================================
	// Disabled
	// =========================================================================

	describe('disabled', () => {
		it('enabled: false → no run_command tool', async () => {
			const harness = createShellHarness({
				presets: [createTestPreset({
					plugins: [shellPlugin.configure({ cwd: '/tmp', sandboxed: false })],
					orchestratorPlugins: [
						shellPlugin.configureAgent({ enabled: false }),
					],
				})],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			const lastRequest = harness.llmProvider.getLastRequest()
			const toolNames = lastRequest?.tools?.map((t) => t.name) ?? []
			expect(toolNames).not.toContain('run_command')

			await harness.shutdown()
		})
	})
})
