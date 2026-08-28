import { describe, expect, it } from 'bun:test'
import { fullPlugins, isolatePlugins } from '~/bootstrap.js'
import type { AgentId } from '~/core/agents/schema.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import { definePlugin } from '~/core/plugins/plugin-builder.js'
import type { TestSession } from '~/testing/index.js'
import { createTestPreset, TestHarness } from '~/testing/index.js'

async function waitForAgentPaused(session: TestSession, agentId: AgentId, timeoutMs = 10000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (session.state.agents.get(agentId)?.status === 'paused') return
		await new Promise(r => setTimeout(r, 10))
	}
	throw new Error(`waitForAgentPaused timed out for agent ${agentId}`)
}

describe('plugin order', () => {
	it('runs agent hooks in declared order, not registration order', async () => {
		const calls: string[] = []
		const probe = (name: string, order?: number) => {
			const builder = definePlugin(name).hook('beforeInference', async () => {
				calls.push(name)
				return null
			})
			return (order === undefined ? builder : builder.order(order)).build()
		}

		const harness = new TestHarness({
			presets: [createTestPreset()],
			llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			// Deliberately registered back to front.
			systemPlugins: [probe('probe-unordered'), probe('probe-mid', 45), probe('probe-first', 5)],
		})

		const session = await harness.createSession('test')
		await session.sendAndWaitForIdle('Hello')

		expect(calls).toEqual(['probe-first', 'probe-mid', 'probe-unordered'])

		await harness.shutdown()
	})

	it('gives the lower order the first non-null result', async () => {
		const pauser = (name: string, order: number) =>
			definePlugin(name)
				.order(order)
				.hook('beforeInference', async () => ({ action: 'pause', reason: name }) as const)
				.build()

		const harness = new TestHarness({
			presets: [createTestPreset()],
			llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			systemPlugins: [pauser('late-pauser', 500), pauser('early-pauser', 5)],
		})

		const session = await harness.createSession('test')
		const entryAgentId = session.getEntryAgentId()!
		await session.sendMessage('Hello')
		await waitForAgentPaused(session, entryAgentId)

		expect(session.state.agents.get(entryAgentId)?.pauseMessage).toBe('early-pauser')

		await harness.shutdown()
	})

	it('slots a declared order among the built-ins and leaves undeclared ones last', async () => {
		const marker = (name: string, order?: number) => {
			const builder = definePlugin(name).systemPrompt(() => `[${name}]`)
			return (order === undefined ? builder : builder.order(order)).build()
		}

		const llmProvider = MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] })
		const harness = new TestHarness({
			presets: [createTestPreset()],
			llmProvider,
			systemPlugins: [marker('unordered-marker'), marker('mid-marker', 45)],
		})

		const session = await harness.createSession('test')
		await session.sendAndWaitForIdle('Hello')

		// Plugin prompt sections are concatenated in the same order the hooks run.
		const prompt = llmProvider.getCallHistory()[0].systemPrompt
		const roleSection = prompt.indexOf('## Your Role')
		const userChatSection = prompt.indexOf('## User Communication')
		expect(roleSection).toBeGreaterThan(-1)
		expect(prompt.indexOf('[mid-marker]')).toBeGreaterThan(roleSection)
		expect(prompt.indexOf('[mid-marker]')).toBeLessThan(userChatSection)
		expect(prompt.indexOf('[unordered-marker]')).toBeGreaterThan(userChatSection)

		await harness.shutdown()
	})

	it('keeps the built-in ladder in step with the full profile', () => {
		// The array no longer decides the order — this catches the two drifting
		// apart, which would silently reshuffle every session.
		expect(fullPlugins.map((plugin) => [plugin.name, plugin.order])).toEqual([
			['sessions', 10],
			['presets', 20],
			['mailbox', 30],
			['agents', 40],
			['agent-status', 50],
			['user-chat', 60],
			['uploads', 70],
			['resources', 80],
			['llm', 90],
			['services', 100],
			['filesystem', 110],
			['logs', 120],
			['session-stats', 130],
			['sessionState', 140],
			['git-status', 150],
		])
	})

	it('gives every profile the same relative order', () => {
		// A profile is a subset, so declared order is all that keeps two hosts
		// from running the same plugins in different sequences.
		for (const profile of [fullPlugins, isolatePlugins]) {
			const orders = profile.map((plugin) => plugin.order)
			expect(orders).not.toContain(undefined)
			expect(orders).toEqual([...orders].sort((a, b) => (a ?? 0) - (b ?? 0)))
		}
	})
})
