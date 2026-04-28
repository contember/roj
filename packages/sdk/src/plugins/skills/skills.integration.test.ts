import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import z from 'zod/v4'
import { agentEvents } from '~/core/agents/state.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import { selectPluginState } from '~/core/sessions/reducer.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { createTestPreset, TestHarness } from '~/testing/index.js'
import { skillEvents, skillsPlugin } from './index.js'
import type { LoadedSkill } from './schema.js'

// ============================================================================
// Helpers
// ============================================================================

function okValue<T>(result: { ok: boolean; value?: unknown }, schema: z.ZodType<T>): T {
	expect(result.ok).toBe(true)
	if (!result.ok) throw new Error('Expected ok result')
	return schema.parse(result.value)
}

const skillsListSchema = z.object({
	skills: z.array(
		z.object({
			id: z.string().optional(),
			name: z.string(),
			description: z.string().optional(),
			loaded: z.boolean(),
		}).passthrough(),
	),
})

const skillLoadSchema = z.object({
	skillId: z.string().optional(),
	message: z.string().optional(),
}).passthrough()

// ============================================================================
// Test fixture: temporary SKILL.md files
// ============================================================================

let skillsDir: string

beforeAll(() => {
	skillsDir = `/tmp/roj-skills-test-${Math.random().toString(36).slice(2)}`

	// Create skill: research
	const researchDir = path.join(skillsDir, 'research')
	fs.mkdirSync(researchDir, { recursive: true })
	fs.writeFileSync(
		path.join(researchDir, 'SKILL.md'),
		`---
name: research
description: Structured research workflow
---
# Research Skill

Use this skill when performing structured research.

## Steps
1. Define the question
2. Search for sources
3. Synthesize findings`,
	)

	// Create skill: code-review
	const codeReviewDir = path.join(skillsDir, 'code-review')
	fs.mkdirSync(codeReviewDir, { recursive: true })
	fs.writeFileSync(
		path.join(codeReviewDir, 'SKILL.md'),
		`---
name: code-review
description: Code review best practices
---
# Code Review Skill

Follow these steps when reviewing code.

## Checklist
- Check for correctness
- Check for readability
- Check for performance`,
	)
})

afterAll(() => {
	fs.rmSync(skillsDir, { recursive: true, force: true })
})

// ============================================================================
// Helpers
// ============================================================================

function createSkillsPreset(overrides?: Parameters<typeof createTestPreset>[0]) {
	return createTestPreset({
		...overrides,
		plugins: [
			skillsPlugin.configure({ sources: [skillsDir] }),
			...(overrides?.plugins ?? []),
		],
	})
}

function createSkillsHarness(options: Omit<ConstructorParameters<typeof TestHarness>[0], 'systemPlugins'>) {
	return new TestHarness({ ...options, systemPlugins: [skillsPlugin] })
}

// ============================================================================
// Tests
// ============================================================================

describe('skills plugin', () => {
	// =========================================================================
	// use_skill tool
	// =========================================================================

	describe('use_skill tool', () => {
		it('agent calls use_skill → skill_loaded event → skill in state', async () => {
			const harness = createSkillsHarness({
				presets: [createSkillsPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'use_skill',
							input: { skill: 'research' },
						}],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Load research skill')

			const events = await session.getEventsByType(skillEvents, 'skill_loaded')
			expect(events).toHaveLength(1)
			expect(events[0].skillName).toBe('research')
			expect(events[0].content).toContain('Research Skill')

			const entryAgentId = session.getEntryAgentId()!
			const loadedSkills = selectPluginState<Map<string, LoadedSkill[]>>(session.state, 'skills')?.get(entryAgentId)
			expect(loadedSkills).toBeDefined()
			expect(loadedSkills).toHaveLength(1)
			expect(loadedSkills![0].name).toBe('research')

			await harness.shutdown()
		})

		it('loaded skill appears in agent preamble (preamble_added event)', async () => {
			const harness = createSkillsHarness({
				presets: [createSkillsPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'use_skill',
							input: { skill: 'research' },
						}],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Load skill')

			const preambleEvents = await session.getEventsByType(agentEvents, 'preamble_added')
			expect(preambleEvents.length).toBeGreaterThanOrEqual(1)

			// At least one preamble event should contain the loaded skill content
			const skillPreamble = preambleEvents.find((e) => e.messages.some((m) => m.role === 'system' && m.content.includes('loaded-skill')))
			expect(skillPreamble).toBeDefined()

			await harness.shutdown()
		})

		it('loading already-loaded skill → returns already loaded message (no duplicate)', async () => {
			const harness = createSkillsHarness({
				presets: [createSkillsPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'use_skill',
							input: { skill: 'research' },
						}],
					},
					{
						toolCalls: [{
							id: ToolCallId('tc2'),
							name: 'use_skill',
							input: { skill: 'research' },
						}],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Load skill twice')

			// Only one skill_loaded event should exist
			const events = await session.getEventsByType(skillEvents, 'skill_loaded')
			expect(events).toHaveLength(1)

			// State should have exactly one loaded skill
			const entryAgentId = session.getEntryAgentId()!
			const loadedSkills = selectPluginState<Map<string, LoadedSkill[]>>(session.state, 'skills')?.get(entryAgentId)
			expect(loadedSkills).toHaveLength(1)

			await harness.shutdown()
		})

		it('loading non-existent skill → error with available skills listed', async () => {
			const harness = createSkillsHarness({
				presets: [createSkillsPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'use_skill',
							input: { skill: 'nonexistent-skill' },
						}],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Load missing skill')

			// No skill_loaded events should exist
			const events = await session.getEventsByType(skillEvents, 'skill_loaded')
			expect(events).toHaveLength(0)

			// Verify the error was sent back to the LLM in the second request
			const callHistory = harness.llmProvider.getCallHistory()
			expect(callHistory).toHaveLength(2)
			const secondRequest = callHistory[1]
			const hasErrorMessage = secondRequest.messages.some((m) => {
				if (m.role !== 'tool') return false
				return typeof m.content === 'string' && m.content.includes('nonexistent-skill')
			})
			expect(hasErrorMessage).toBe(true)

			await harness.shutdown()
		})
	})

	// =========================================================================
	// skills.list method
	// =========================================================================

	describe('skills.list method', () => {
		it('list skills → returns all available skills with loaded status', async () => {
			const harness = createSkillsHarness({
				presets: [createSkillsPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			const entryAgentId = session.getEntryAgentId()!
			const result = await session.callPluginMethod('skills.list', {
				sessionId: String(session.sessionId),
				agentId: String(entryAgentId),
			})

			const data = okValue(result, skillsListSchema)
			expect(data.skills).toHaveLength(2)

			const names = data.skills.map((s) => s.name)
			expect(names).toContain('research')
			expect(names).toContain('code-review')

			// None loaded yet
			for (const skill of data.skills) {
				expect(skill.loaded).toBe(false)
			}

			await harness.shutdown()
		})

		it('after loading a skill → its loaded flag is true', async () => {
			const harness = createSkillsHarness({
				presets: [createSkillsPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'use_skill',
							input: { skill: 'research' },
						}],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Load skill')

			const entryAgentId = session.getEntryAgentId()!
			const result = await session.callPluginMethod('skills.list', {
				sessionId: String(session.sessionId),
				agentId: String(entryAgentId),
			})

			const data = okValue(result, skillsListSchema)
			const research = data.skills.find((s) => s.name === 'research')
			const codeReview = data.skills.find((s) => s.name === 'code-review')

			expect(research?.loaded).toBe(true)
			expect(codeReview?.loaded).toBe(false)

			await harness.shutdown()
		})
	})

	// =========================================================================
	// skills.load method
	// =========================================================================

	describe('skills.load method', () => {
		it('load by name → skill content loaded and event emitted', async () => {
			const harness = createSkillsHarness({
				presets: [createSkillsPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			const entryAgentId = session.getEntryAgentId()!
			const result = await session.callPluginMethod('skills.load', {
				sessionId: String(session.sessionId),
				agentId: String(entryAgentId),
				skillName: 'code-review',
			})

			const data = okValue(result, skillLoadSchema)
			expect(data.skillId).toBe('code-review')

			const events = await session.getEventsByType(skillEvents, 'skill_loaded')
			expect(events).toHaveLength(1)
			expect(events[0].skillName).toBe('code-review')
			expect(events[0].content).toContain('Code Review Skill')

			await harness.shutdown()
		})

		it('load unknown skill → error', async () => {
			const harness = createSkillsHarness({
				presets: [createSkillsPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			const entryAgentId = session.getEntryAgentId()!
			const result = await session.callPluginMethod('skills.load', {
				sessionId: String(session.sessionId),
				agentId: String(entryAgentId),
				skillName: 'does-not-exist',
			})

			expect(result.ok).toBe(false)

			await harness.shutdown()
		})
	})

	// =========================================================================
	// onStart (preload)
	// =========================================================================

	describe('onStart (preload)', () => {
		it('agent config with preload → skill auto-loaded on start', async () => {
			const harness = createSkillsHarness({
				presets: [createSkillsPreset({
					orchestratorPlugins: [
						skillsPlugin.configureAgent({ preload: ['research'] }),
					],
				})],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			// skill_loaded event should have been emitted during onStart
			const events = await session.getEventsByType(skillEvents, 'skill_loaded')
			expect(events).toHaveLength(1)
			expect(events[0].skillName).toBe('research')

			// State should have the preloaded skill
			const entryAgentId = session.getEntryAgentId()!
			const loadedSkills = selectPluginState<Map<string, LoadedSkill[]>>(session.state, 'skills')?.get(entryAgentId)
			expect(loadedSkills).toBeDefined()
			expect(loadedSkills).toHaveLength(1)
			expect(loadedSkills![0].name).toBe('research')

			await harness.shutdown()
		})

		it('all preloaded skills appear in preamble', async () => {
			const harness = createSkillsHarness({
				presets: [createSkillsPreset({
					orchestratorPlugins: [
						skillsPlugin.configureAgent({ preload: ['research', 'code-review'] }),
					],
				})],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			const events = await session.getEventsByType(skillEvents, 'skill_loaded')
			expect(events).toHaveLength(2)

			// A preamble_added event should contain loaded-skill content
			const preambleEvents = await session.getEventsByType(agentEvents, 'preamble_added')
			const skillPreamble = preambleEvents.find((e) => e.messages.some((m) => m.role === 'system' && m.content.includes('Loaded Skills')))
			expect(skillPreamble).toBeDefined()

			await harness.shutdown()
		})
	})

	// =========================================================================
	// tools generation
	// =========================================================================

	describe('tools generation', () => {
		it('no available skills → no use_skill tool generated', async () => {
			// Use a non-existent sources directory so no skills are discovered
			const harness = createSkillsHarness({
				presets: [createTestPreset({
					plugins: [skillsPlugin.configure({ sources: ['/tmp/nonexistent-skills-dir'] })],
				})],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			const lastRequest = harness.llmProvider.getLastRequest()
			const toolNames = lastRequest?.tools?.map((t) => t.name) ?? []
			expect(toolNames).not.toContain('use_skill')

			await harness.shutdown()
		})

		it('available skills → use_skill tool description lists them', async () => {
			const harness = createSkillsHarness({
				presets: [createSkillsPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			const lastRequest = harness.llmProvider.getLastRequest()
			const useSkillTool = lastRequest?.tools?.find((t) => t.name === 'use_skill')
			expect(useSkillTool).toBeDefined()
			expect(useSkillTool!.description).toContain('research')
			expect(useSkillTool!.description).toContain('code-review')

			await harness.shutdown()
		})
	})

	// =========================================================================
	// preset-provided skills (inline)
	// =========================================================================

	describe('preset-provided skills', () => {
		const inlineSkill = {
			name: 'summarize',
			description: 'Summarize long documents',
			content: '# Summarize\n\nCondense a document into 3 bullet points.',
		}

		it('inline skills appear in list alongside file-discovered skills', async () => {
			const harness = createSkillsHarness({
				presets: [createTestPreset({
					plugins: [skillsPlugin.configure({ sources: [skillsDir], skills: [inlineSkill] })],
				})],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			const agentId = session.getEntryAgentId()!

			const listResult = await session.callPluginMethod('skills.list', {
				sessionId: String(session.sessionId),
				agentId: String(agentId),
			})
			const parsed = okValue(listResult, skillsListSchema)
			const names = parsed.skills.map((s) => s.name).sort()
			expect(names).toEqual(['code-review', 'research', 'summarize'])

			await harness.shutdown()
		})

		it('inline skill can be loaded via use_skill tool', async () => {
			const harness = createSkillsHarness({
				presets: [createTestPreset({
					plugins: [skillsPlugin.configure({ sources: [], skills: [inlineSkill] })],
				})],
				llmProvider: MockLLMProvider.withSequence([
					{ toolCalls: [{ id: ToolCallId('tc1'), name: 'use_skill', input: { skill: 'summarize' } }] },
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Summarize please')

			const events = await session.getEventsByType(skillEvents, 'skill_loaded')
			expect(events).toHaveLength(1)
			expect(events[0].skillName).toBe('summarize')
			expect(events[0].content).toContain('Condense a document')

			await harness.shutdown()
		})

		it('inline skill can be preloaded via agent config', async () => {
			const harness = createSkillsHarness({
				presets: [createTestPreset({
					plugins: [skillsPlugin.configure({ sources: [], skills: [inlineSkill] })],
					orchestratorPlugins: [skillsPlugin.configureAgent({ preload: ['summarize'] })],
				})],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			const entryAgentId = session.getEntryAgentId()!
			const loadedSkills = selectPluginState<Map<string, LoadedSkill[]>>(session.state, 'skills')?.get(entryAgentId)
			expect(loadedSkills).toHaveLength(1)
			expect(loadedSkills![0].name).toBe('summarize')
			expect(loadedSkills![0].content).toContain('Condense a document')

			await harness.shutdown()
		})

		it('file-discovered skill overrides inline skill with same name', async () => {
			// `research` exists as a SKILL.md in skillsDir; the inline one below must be dropped.
			const harness = createSkillsHarness({
				presets: [createTestPreset({
					plugins: [skillsPlugin.configure({
						sources: [skillsDir],
						skills: [{ name: 'research', description: 'Inline version', content: 'inline body' }],
					})],
				})],
				llmProvider: MockLLMProvider.withSequence([
					{ toolCalls: [{ id: ToolCallId('tc1'), name: 'use_skill', input: { skill: 'research' } }] },
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Go')

			const events = await session.getEventsByType(skillEvents, 'skill_loaded')
			expect(events).toHaveLength(1)
			// Content must come from the file, not the inline fallback
			expect(events[0].content).toContain('Define the question')
			expect(events[0].content).not.toContain('inline body')

			await harness.shutdown()
		})
	})
})
