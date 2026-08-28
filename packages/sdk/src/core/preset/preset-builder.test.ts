import { describe, expect, test } from 'bun:test'
import type { AgentDefinition } from '~/core/agents/config.js'
import { ModelId } from '~/core/llm/schema.js'
import { createPreset } from './config.js'
import { createOrchestrator, defineAgent } from './preset-builder.js'

const agent = (name: string, agents: AgentDefinition[] = []) =>
	defineAgent({ name, system: `${name} system`, model: ModelId('mock'), agents })

describe('preset-builder', () => {
	test('resolves object refs to names', () => {
		const child = agent('child')
		const parent = agent('parent', [child])

		expect(parent.agents).toEqual(['child'])
	})

	test('createPreset collects the whole tree', () => {
		const leaf = agent('leaf')
		const child = agent('child', [leaf])
		const preset = createPreset({
			id: 'p',
			name: 'P',
			orchestrator: createOrchestrator({ system: 'root', model: ModelId('mock'), agents: [child] }),
		})

		expect(preset.agents.map((a) => a.name).sort()).toEqual(['child', 'leaf'])
	})

	test('a spread definition keeps its children', () => {
		const leaf = agent('leaf')
		const child = agent('child', [leaf])
		const root = agent('root', [child])

		const spread: AgentDefinition = { ...root }
		const preset = createPreset({ id: 'p', name: 'P', orchestrator: spread })

		expect(preset.agents.map((a) => a.name).sort()).toEqual(['child', 'leaf'])
	})

	test('a spread orchestrator keeps its children', () => {
		const child = agent('child')
		const root = createOrchestrator({ system: 'root', model: ModelId('mock'), agents: [child] })

		const preset = createPreset({ id: 'p', name: 'P', orchestrator: { ...root } })

		expect(preset.agents.map((a) => a.name)).toEqual(['child'])
	})
})
