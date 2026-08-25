/**
 * A rebuilt runtime must project the same state the evicted one held.
 *
 * The per-plugin suites check their own slice in isolation, and the rebuild
 * tests check behaviour (queued work resumes, idle agents stay idle). Neither
 * catches a slice that replays to something subtly different once the retention
 * work has pruned consumed inputs, skill content, worker results and upload
 * payloads out of the log's projection. This compares the whole SessionState.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import z from 'zod/v4'
import type { AgentId } from '~/core/agents/schema.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { Ok } from '~/lib/utils/result.js'
import { sessionStatePlugin } from '~/plugins/session-state/plugin.js'
import { skillsPlugin } from '~/plugins/skills/index.js'
import { createWorkerDefinition, workerPlugin } from '~/plugins/workers/index.js'
import { createTestPreset, TestHarness } from '~/testing/index.js'
import type { SessionState } from './state.js'

const skillsDir = path.join('/tmp', `roj-state-equivalence-${Math.random().toString(36).slice(2)}`)

beforeAll(() => {
	const researchDir = path.join(skillsDir, 'research')
	fs.mkdirSync(researchDir, { recursive: true })
	fs.writeFileSync(
		path.join(researchDir, 'SKILL.md'),
		`---
name: research
description: Structured research workflow
---
# Research Skill

Body long enough that dropping it from the projection is the whole point.`,
	)
})

afterAll(() => {
	fs.rmSync(skillsDir, { recursive: true, force: true })
})

const immediateWorker = createWorkerDefinition(
	'immediate',
	'Completes immediately',
	z.object({ value: z.string() }),
	{
		initialState: () => ({ count: 0 }),
		reduce: (state: { count: number }) => state,
		execute: async (config) => Ok({ status: 'done', summary: `Processed: ${config.value}` }),
	},
)

/** Maps and Sets are not structurally comparable, so render them as sorted plain data. */
const normalize = (value: unknown): unknown => {
	if (value instanceof Map) {
		return {
			__map: [...value.entries()]
				.map(([key, entry]) => [String(key), normalize(entry)] as const)
				.sort((a, b) => a[0].localeCompare(b[0])),
		}
	}
	if (value instanceof Set) {
		return { __set: [...value].map((entry) => JSON.stringify(normalize(entry))).sort() }
	}
	if (Array.isArray(value)) return value.map(normalize)
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, entry]) => [key, normalize(entry)]),
		)
	}
	return value
}

const waitForEviction = async (harness: TestHarness): Promise<void> => {
	const deadline = Date.now() + 5_000
	while (Date.now() < deadline && harness.sessionManager.getRuntimeCacheStats().loadedSessionCount > 0) {
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
	expect(harness.sessionManager.getRuntimeCacheStats().loadedSessionCount).toBe(0)
}

const createHarness = (onTurn: () => number) =>
	new TestHarness({
		systemPlugins: [workerPlugin, skillsPlugin],
		presets: [
			createTestPreset({
				workspaceDir: '/tmp',
				plugins: [
					skillsPlugin.configure({ sources: [skillsDir] }),
					workerPlugin.configure({ workers: [immediateWorker] }),
					sessionStatePlugin.configure({
						schema: z.object({ phase: z.string() }),
						initial: { phase: 'idle' },
					}),
				],
			}),
		],
		sessionIdleTimeoutMs: 150,
		mockHandler: () => {
			const turn = onTurn()
			if (turn === 1) {
				return {
					content: null,
					toolCalls: [
						{ id: ToolCallId('tc1'), name: 'tell_user', input: { message: 'Hello!' } },
						{ id: ToolCallId('tc2'), name: 'use_skill', input: { skill: 'research' } },
						{ id: ToolCallId('tc3'), name: 'worker_immediate_start', input: { value: 'payload' } },
						{ id: ToolCallId('tc4'), name: 'update_session_state', input: { updates: { phase: 'building' } } },
					],
					finishReason: 'tool_calls' as const,
					metrics: MockLLMProvider.defaultMetrics(),
				}
			}
			if (turn === 2) {
				return {
					content: null,
					toolCalls: [{ id: ToolCallId('tc5'), name: 'ask_user', input: { question: 'Which one?', inputType: 'text' } }],
					finishReason: 'tool_calls' as const,
					metrics: MockLLMProvider.defaultMetrics(),
				}
			}
			return {
				content: 'Done',
				toolCalls: [],
				finishReason: 'stop' as const,
				metrics: MockLLMProvider.defaultMetrics(),
			}
		},
	})

describe('session state equivalence across eviction', () => {
	it('rebuilds a session to the same state it was evicted with', async () => {
		let turns = 0
		const harness = createHarness(() => ++turns)

		try {
			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi', { timeoutMs: 10_000 })

			// Answer the pending question so nothing is left queued — a rebuild that
			// legitimately resumes work would otherwise diverge for the right reason.
			const agentId = session.getEntryAgentId()
			if (!agentId) throw new Error('Session has no entry agent')
			await session.answerQuestion(agentId, 'm3', 'the first one')
			await session.waitForIdle({ timeoutMs: 10_000 })

			const uploaded = await session.callPluginMethod('uploads.upload', {
				sessionId: String(session.sessionId),
				filename: 'notes.txt',
				mimeType: 'text/plain',
				size: 64,
				fileBuffer: Buffer.alloc(64, 7),
			})
			expect(uploaded.ok).toBe(true)
			if (!uploaded.ok) throw new Error('Expected the upload to succeed')
			const { uploadId } = uploaded.value as { uploadId: string }
			await session.callPluginMethod('uploads.markUsed', {
				sessionId: String(session.sessionId),
				uploadIds: [uploadId],
				messageId: 'm1',
			})
			await session.waitForIdle({ timeoutMs: 10_000 })

			// Guard against a vacuous pass: every slice the retention work prunes must
			// actually have been exercised before the comparison means anything.
			expect(session.getPluginState<Map<AgentId, unknown[]>>('skills')).toEqual(
				new Map([[agentId, [{ id: 'research', name: 'research', loadedAt: expect.any(Number) }]]]),
			)
			expect([...(session.getPluginState<Map<string, { status: string }>>('workers') ?? []).values()]).toEqual([
				expect.objectContaining({ status: 'completed' }),
			])
			expect(session.getPluginState<Record<string, unknown>>('uploads')).toEqual({ pending: [], terminal: {} })
			expect(session.getPluginState<Record<string, unknown>>('sessionState')).toEqual(
				expect.objectContaining({ state: { phase: 'building' } }),
			)

			const before = normalize(session.state as SessionState)
			const turnsBeforeEviction = turns

			await waitForEviction(harness)
			const reopened = await harness.openSession(session.sessionId)
			await reopened.waitForIdle({ timeoutMs: 10_000 })

			expect(normalize(reopened.state as SessionState)).toEqual(before)
			// A rebuild that re-ran an agent would produce equal state only by luck.
			expect(turns).toBe(turnsBeforeEviction)
		} finally {
			await harness.shutdown()
		}
	})
})
