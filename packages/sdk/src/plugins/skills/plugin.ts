/**
 * Skills Plugin - Progressive disclosure of reusable instruction sets
 *
 * Level 1 (Preset): SkillsPresetConfig with skill source directories
 * Level 2 (Session): Plugin context with discovered skills, methods (load, list)
 * Level 3 (Agent): Agent-specific skill config (preload, sources override), tools, status
 */

import z from 'zod/v4'
import { AgentId, agentIdSchema } from '~/core/agents/schema.js'
import { agentEvents } from '~/core/agents/state.js'
import { ValidationErrors } from '~/core/errors.js'
import { createEventsFactory as createEvents } from '~/core/events/types.js'
import { definePlugin } from '~/core/plugins/plugin-builder.js'
import { selectPluginState } from '~/core/sessions/reducer.js'
import type { SessionState } from '~/core/sessions/state.js'
import { createTool } from '~/core/tools/definition.js'
import { Err, Ok, type Result } from '~/lib/utils/result.js'
import { discoverSkills, loadSkillContent } from './discovery.js'
import { buildLoadedSkillsMessage, formatLoadedSkills } from './prompts.js'
import { type LoadedSkill, SkillId, skillIdSchema, type SkillMetadata } from './schema.js'

/**
 * A preset-contributed skill. Skills are matched by name; file-discovered
 * skills from user sources take precedence over inline preset skills with
 * the same name (lets projects override the defaults).
 */
export interface PresetSkill {
	name: string
	description: string
	content: string
}

async function readSkillContent(
	fs: import('~/platform/fs.js').FileSystem,
	meta: SkillMetadata,
): Promise<Result<string, { message: string }>> {
	if (meta.source === 'inline') {
		return Ok(meta.content)
	}
	const result = await loadSkillContent(fs, meta.sourcePath)
	if (!result.ok) {
		return Err({ message: result.error.message })
	}
	return Ok(result.value)
}

/**
 * Extract loaded skills for an agent from session state (for external consumers).
 */
export function selectAgentSkills(sessionState: SessionState, agentId: AgentId): LoadedSkill[] {
	return selectPluginState<Map<AgentId, LoadedSkill[]>>(sessionState, 'skills')?.get(agentId) ?? []
}

/**
 * Session-wide skill configuration.
 */
export interface SkillsPluginConfig {
	/**
	 * Directories to scan for SKILL.md files. Supports `{{workspaceDir}}` and
	 * `{{sessionDir}}` placeholders; sources referencing `{{workspaceDir}}` are
	 * skipped for sessions without a workspace. Relative paths resolve against
	 * the agent server cwd.
	 */
	sources: string[]
	/**
	 * Skills contributed directly by the preset. They behave identically to
	 * filesystem-discovered skills (same `load`/`list`/`use_skill`/`preload`
	 * flow), but content is kept in memory instead of read from disk. A skill
	 * discovered from `sources` with the same name overrides the preset one.
	 */
	skills?: PresetSkill[]
}

/**
 * Agent-specific skill configuration.
 */
export interface SkillsAgentConfig {
	/** Override skill sources for this agent (default: use preset sources) */
	sources?: string[]
	/** Skills to auto-load when agent starts */
	preload?: string[]
}

/**
 * Plugin context - session-wide state.
 */
export interface SkillsPluginContext {
	/** Available skills discovered from sources */
	availableSkills: SkillMetadata[]
}

export const skillEvents = createEvents({
	events: {
		skill_loaded: z.object({
			agentId: agentIdSchema,
			skillId: skillIdSchema,
			skillName: z.string(),
			content: z.string(),
		}),
	},
})

export type SkillLoadedEvent = (typeof skillEvents)['Events']['skill_loaded']

export const skillsPlugin = definePlugin('skills')
	.pluginConfig<SkillsPluginConfig>()
	.agentConfig<SkillsAgentConfig>()
	.events([skillEvents])
	.state({
		key: 'skills',
		initial: (): Map<AgentId, LoadedSkill[]> => new Map(),
		reduce: (skills, event) => {
			switch (event.type) {
				case 'skill_loaded': {
					const loadedSkill: LoadedSkill = {
						id: event.skillId,
						name: event.skillName,
						content: event.content,
						loadedAt: event.timestamp,
					}
					const agentSkills = skills.get(event.agentId) ?? []
					const newSkills = new Map(skills)
					newSkills.set(event.agentId, [...agentSkills, loadedSkill])
					return newSkills
				}

				default:
					return skills
			}
		},
	})
	.context(async (ctx, pluginConfig) => {
		// Interpolate {{workspaceDir}} / {{sessionDir}} placeholders.
		// Sources referencing {{workspaceDir}} are skipped when the session has no workspace.
		const workspaceDir = ctx.environment.workspaceDir
		const sessionDir = ctx.environment.sessionDir
		const resolvedSources: string[] = []
		for (const source of pluginConfig.sources) {
			if (source.includes('{{workspaceDir}}') && !workspaceDir) {
				continue
			}
			resolvedSources.push(
				source
					.replaceAll('{{workspaceDir}}', workspaceDir ?? '')
					.replaceAll('{{sessionDir}}', sessionDir),
			)
		}

		const fileSkillsResult = await discoverSkills(ctx.platform.fs, resolvedSources, '.')
		if (!fileSkillsResult.ok) {
			console.warn(`[skills] Discovery failed: ${fileSkillsResult.error.message}`)
			return { availableSkills: [] }
		}

		// Merge preset-contributed skills. File-discovered skills take precedence:
		// if the same name appears in both, the inline one is dropped.
		const fileSkillNames = new Set(fileSkillsResult.value.map((s) => s.name))
		const inlineSkills: SkillMetadata[] = []
		const seenInline = new Set<string>()
		for (const skill of pluginConfig.skills ?? []) {
			if (fileSkillNames.has(skill.name)) {
				continue
			}
			if (seenInline.has(skill.name)) {
				console.warn(`[skills] Duplicate inline skill "${skill.name}" — ignoring later entry`)
				continue
			}
			seenInline.add(skill.name)
			inlineSkills.push({
				source: 'inline',
				id: SkillId(skill.name),
				name: skill.name,
				description: skill.description,
				content: skill.content,
			})
		}

		return {
			availableSkills: [...fileSkillsResult.value, ...inlineSkills],
		}
	})
	.method('load', {
		input: z.object({
			sessionId: z.string(),
			agentId: agentIdSchema,
			skillName: z.string(),
		}),
		output: z.object({
			skillId: z.string().optional(),
			message: z.string().optional(),
		}),
		handler: async (ctx, input) => {
			const availableSkills = ctx.pluginContext.availableSkills
			const skillMeta = availableSkills.find((s) => s.name === input.skillName)

			if (!skillMeta) {
				const availableNames = availableSkills.map((s) => s.name).join(', ')
				const message = availableNames
					? `Unknown skill: "${input.skillName}". Available: ${availableNames}`
					: `Unknown skill: "${input.skillName}". No skills configured.`
				return Err(ValidationErrors.invalid(message))
			}

			// Check if already loaded
			const agentId = AgentId(input.agentId)
			const agentSkills = ctx.pluginState.get(agentId)
			if (agentSkills?.some((s) => s.id === skillMeta.id)) {
				return Ok({
					skillId: skillMeta.id,
					message: `Skill "${input.skillName}" is already loaded.`,
				})
			}

			// Load skill content
			const contentResult = await readSkillContent(ctx.platform.fs, skillMeta)
			if (!contentResult.ok) {
				return Err(ValidationErrors.invalid(`Failed to load skill: ${contentResult.error.message}`))
			}

			// Emit skill_loaded event
			await ctx.emitEvent(skillEvents.create('skill_loaded', {
				agentId: input.agentId,
				skillId: skillMeta.id,
				skillName: skillMeta.name,
				content: contentResult.value,
			}))

			// Emit preamble with the newly loaded skill
			const skillContent = formatLoadedSkills([{
				id: skillMeta.id,
				name: skillMeta.name,
				content: contentResult.value,
				loadedAt: Date.now(),
			}])
			await ctx.emitEvent(agentEvents.create('preamble_added', {
				agentId: input.agentId,
				messages: [{ role: 'system', content: skillContent }],
			}))

			return Ok({
				skillId: skillMeta.id,
				message: `Skill "${input.skillName}" loaded successfully.`,
			})
		},
	})
	.method('list', {
		input: z.object({
			sessionId: z.string(),
			agentId: agentIdSchema,
		}),
		output: z.object({
			skills: z.array(
				z.object({
					id: z.string(),
					name: z.string(),
					description: z.string(),
					loaded: z.boolean(),
				}),
			),
		}),
		handler: async (ctx, input) => {
			const availableSkills = ctx.pluginContext.availableSkills
			const agentSkills = ctx.pluginState.get(AgentId(input.agentId))
			const loadedSkillIds = new Set(agentSkills?.map((s) => s.id) ?? [])

			return Ok({
				skills: availableSkills.map((s) => ({
					id: s.id,
					name: s.name,
					description: s.description,
					loaded: loadedSkillIds.has(s.id),
				})),
			})
		},
	})
	.sessionHook('onSessionReady', async () => {
		// No session-wide initialization needed for now
	})
	.hook('onStart', async (ctx) => {
		const preloadSkills = ctx.pluginAgentConfig?.preload
		if (!preloadSkills || preloadSkills.length === 0) {
			return null
		}

		// Load preload skills
		const availableSkills = ctx.pluginContext.availableSkills
		const skillByName = new Map(availableSkills.map((s) => [s.name, s]))
		const newlyLoaded: LoadedSkill[] = []

		for (const skillName of preloadSkills) {
			const skillMeta = skillByName.get(skillName)
			if (!skillMeta) {
				console.warn(`[skills] Preload skill not found: "${skillName}"`)
				continue
			}

			// Check if already loaded
			const agentSkills = ctx.pluginState.get(ctx.agentId)
			if (agentSkills?.some((s) => s.id === skillMeta.id)) {
				continue
			}

			// Load skill content
			const contentResult = await readSkillContent(ctx.platform.fs, skillMeta)
			if (!contentResult.ok) {
				console.warn(`[skills] Failed to load preload skill "${skillName}": ${contentResult.error.message}`)
				continue
			}

			// Emit skill_loaded event
			await ctx.emitEvent(skillEvents.create('skill_loaded', {
				agentId: ctx.agentId,
				skillId: skillMeta.id,
				skillName: skillMeta.name,
				content: contentResult.value,
			}))

			newlyLoaded.push({
				id: skillMeta.id,
				name: skillMeta.name,
				content: contentResult.value,
				loadedAt: Date.now(),
			})
		}

		// Emit preamble with all preloaded skills
		if (newlyLoaded.length > 0) {
			const skillsMessage = buildLoadedSkillsMessage(newlyLoaded)
			if (skillsMessage) {
				await ctx.emitEvent(agentEvents.create('preamble_added', {
					agentId: ctx.agentId,
					messages: [{ role: 'system', content: skillsMessage }],
				}))
			}
		}

		return null
	})
	.tools((ctx) => {
		const availableSkills = ctx.pluginContext?.availableSkills ?? []

		if (availableSkills.length === 0) {
			return []
		}

		const skillsList = availableSkills
			.map((s) => `- ${s.name}: ${s.description}`)
			.join('\n')

		return [
			createTool({
				name: 'use_skill',
				description:
					`Load a skill's full instructions into your context. Use this when you need detailed instructions for a skill from the Available Skills list. The skill content will be injected into your context for subsequent turns.

Available skills:
${skillsList}`,
				input: z.object({
					skill: z.string().describe('Name of the skill to load (from the Available Skills list)'),
				}),
				execute: async (input, context) => {
					const result = await ctx.self.load({
						sessionId: ctx.sessionState.id,
						agentId: context.agentId,
						skillName: input.skill,
					})

					if (!result.ok) {
						return Err({
							message: result.error.message,
							recoverable: false,
						})
					}

					return Ok(result.value.message ?? `Skill "${input.skill}" loaded successfully.`)
				},
			}),
		]
	})
	.build()
