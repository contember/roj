import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootstrap, createSystemFromServices, MockLLMProvider, ToolCallId } from '@roj-ai/sdk'
import type { Config, DomainEvent, SessionId } from '@roj-ai/sdk'
import { filesystemPlugin } from '@roj-ai/sdk/tools/filesystem'
import { shellPlugin } from '@roj-ai/sdk/tools/shell'
import { createTestPreset, waitForAllAgentsIdle } from '@roj-ai/sdk/testing'
import { expect, test } from 'bun:test'
import { createGit, Workspace } from '@kompjutr/do'
import { KompjutrEventStore, createKompjutrPlatform } from './index.js'
import { BunSqliteStorage } from './testing/storage.js'

const DATA = '/data'
const WORKSPACE = '/workspace'
const PRESET = 'kompjutr-workflow'

function testConfig(provider: MockLLMProvider): Config {
	return {
		port: 0,
		host: 'localhost',
		dataPath: DATA,
		persistence: 'memory',
		logLevel: 'error',
		logFormat: 'console',
		llmLoggingEnabled: true,
		llmMock: async (request) => {
			const result = await provider.inference(request)
			if (!result.ok) throw new Error(result.error.message)
			return result.value
		},
	}
}

function testPreset() {
	return createTestPreset({
		id: PRESET,
		workspaceDir: WORKSPACE,
		plugins: [
			filesystemPlugin.configure({ respectGitignore: false }),
			shellPlugin.configure({
				cwd: WORKSPACE,
				sandboxed: true,
				timeout: 10_000,
			}),
		],
	})
}

function boot(databasePath: string, provider: MockLLMProvider) {
	const storage = new BunSqliteStorage(databasePath)
	const workspace = new Workspace({
		storage,
		git: createGit(),
		defaultGitIdentity: { name: 'Roj', email: 'roj@example.com' },
	})
	workspace.filesystem.mkdir(DATA, { recursive: true })
	workspace.filesystem.mkdir(WORKSPACE, { recursive: true })

	const platform = createKompjutrPlatform(workspace, {
		shellConfinement: 'host',
	})
	const eventStore = new KompjutrEventStore(workspace.db)
	const services = bootstrap(testConfig(provider), { presets: [testPreset()] }, platform, { eventStore, pluginProfile: 'isolate' })

	return {
		storage,
		workspace,
		platform,
		eventStore,
		system: createSystemFromServices(services),
	}
}

function startedToolNames(events: readonly DomainEvent[]): string[] {
	return events.flatMap((event) => (event.type === 'tool_started' && 'toolName' in event && typeof event.toolName === 'string' ? [event.toolName] : []))
}

async function sendTurn(runtime: ReturnType<typeof boot>, sessionId?: SessionId) {
	const sessionResult =
		sessionId === undefined
			? await runtime.system.sessionManager.createSession(PRESET, {
					workspaceDir: WORKSPACE,
				})
			: await runtime.system.sessionManager.getSession(sessionId)
	if (!sessionResult.ok) throw new Error(sessionResult.error.message)

	const session = sessionResult.value
	const agentId = session.getEntryAgentId()
	if (agentId === null) throw new Error('session has no entry agent')
	const sent = await session.callPluginMethod('user-chat.sendMessage', {
		sessionId: String(session.id),
		content: 'Run the workflow',
		agentId: String(agentId),
	})
	if (!sent.ok) throw new Error(sent.error.message)
	await waitForAllAgentsIdle(session, { timeoutMs: 20_000 })
	return session
}

test('Roj tools and state survive reopening the kompjutr SQLite workspace', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'roj-kompjutr-workflow-'))
	const databasePath = join(directory, 'workspace.sqlite')
	let active: ReturnType<typeof boot> | undefined

	try {
		const provider = MockLLMProvider.withSequence([
			{
				toolCalls: [
					{
						id: ToolCallId('default-cwd'),
						name: 'run_command',
						input: { command: 'pwd > /workspace/default-cwd.txt' },
					},
				],
			},
			{
				toolCalls: [
					{
						id: ToolCallId('write-note'),
						name: 'write_file',
						input: {
							path: `${WORKSPACE}/note.txt`,
							content: 'hello from Roj\n',
						},
					},
				],
			},
			{
				toolCalls: [
					{
						id: ToolCallId('commit-note'),
						name: 'run_command',
						input: {
							command: 'git init --initial-branch=main && git add note.txt && git commit -m initial',
							cwd: WORKSPACE,
						},
					},
				],
			},
			{
				toolCalls: [
					{
						id: ToolCallId('write-dirty'),
						name: 'run_command',
						input: {
							command: "printf '%s\\n' dirty > dirty.txt",
							cwd: WORKSPACE,
						},
					},
				],
			},
			{
				toolCalls: [
					{
						id: ToolCallId('read-note'),
						name: 'read_file',
						input: { path: `${WORKSPACE}/note.txt` },
					},
				],
			},
			{ content: 'Done', toolCalls: [] },
		])
		active = boot(databasePath, provider)
		const session = await sendTurn(active)
		const sessionId = session.id

		expect(provider.getCallCount()).toBe(6)
		expect((await active.eventStore.load(sessionId)).filter(event => event.type === 'tool_failed')).toEqual([])
		expect(await active.platform.fs.readFile(`${WORKSPACE}/default-cwd.txt`, 'utf-8')).toBe(`/data/sessions/${sessionId}\n`)
		await active.platform.fs.unlink(`${WORKSPACE}/default-cwd.txt`)
		expect(await active.platform.fs.readFile(`${WORKSPACE}/note.txt`, 'utf-8')).toBe('hello from Roj\n')
		expect(await active.platform.fs.readFile(`${WORKSPACE}/dirty.txt`, 'utf-8')).toBe('dirty\n')

		const git = active.platform.git
		if (git === undefined) throw new Error('kompjutr Git port is absent')
		expect(await git.status({ dir: WORKSPACE })).toEqual([{ path: 'dirty.txt', index: ' ', worktree: '?' }])
		expect((await git.log({ dir: WORKSPACE, depth: 1 }))[0]?.message.trim()).toBe('initial')

		const refreshed = await session.callPluginMethod('git-status.refresh', {})
		expect(refreshed).toMatchObject({
			ok: true,
			value: {
				snapshot: {
					committedAhead: 0,
					uncommittedFiles: 1,
					lastCommitMessage: 'initial',
				},
			},
		})

		const events = await active.eventStore.load(sessionId)
		expect(startedToolNames(events)).toEqual(['run_command', 'write_file', 'run_command', 'run_command', 'read_file'])
		expect(events.filter((event) => event.type === 'tool_failed')).toEqual([])
		await active.system.shutdown()
		active.storage.close()
		active = undefined

		const reopenedProvider = MockLLMProvider.withFixedResponse({
			content: 'Resumed',
			toolCalls: [],
		})
		active = boot(databasePath, reopenedProvider)
		const reopenedResult = await active.system.sessionManager.getSession(sessionId)
		if (!reopenedResult.ok) throw new Error(reopenedResult.error.message)
		expect(reopenedResult.value.state.workspaceDir).toBe(WORKSPACE)
		expect(startedToolNames(await active.eventStore.load(sessionId))).toEqual(startedToolNames(events))
		expect(await active.platform.fs.readFile(`${WORKSPACE}/dirty.txt`, 'utf-8')).toBe('dirty\n')

		const reopenedGit = active.platform.git
		if (reopenedGit === undefined) throw new Error('reopened kompjutr Git port is absent')
		expect(await reopenedGit.status({ dir: WORKSPACE })).toEqual([{ path: 'dirty.txt', index: ' ', worktree: '?' }])
		expect((await reopenedGit.log({ dir: WORKSPACE, depth: 1 }))[0]?.message.trim()).toBe('initial')

		await sendTurn(active, sessionId)
		expect(reopenedProvider.getCallCount()).toBe(1)
		expect((await active.eventStore.load(sessionId)).length).toBeGreaterThan(events.length)
	} finally {
		if (active !== undefined) {
			await active.system.shutdown()
			active.storage.close()
		}
		await rm(directory, { recursive: true, force: true })
	}
}, 60_000)
