/**
 * Skills module - Skill discovery and loading.
 */

// Plugin
export { skillsPlugin } from './plugin.js'
export type {
	PresetSkill,
	SkillsAgentConfig,
	SkillsPluginConfig as SkillsPresetConfig,
	SkillsPluginContext,
} from './plugin.js'

// Schema
export { SkillId, skillIdSchema } from './schema.js'
export type { LoadedSkill, SkillMetadata } from './schema.js'

// Events & state slice (now in plugin.ts)
export { skillEvents } from './plugin.js'
export type { SkillLoadedEvent } from './plugin.js'

// Discovery (internal use)
export {
	discoverSkills,
	type FrontmatterParseError,
	loadSkillContent,
	type ParsedFrontmatter,
	type ParsedSkillFile,
	parseSkillFile,
	parseSkillFrontmatter,
	type SkillDiscoveryError,
} from './discovery.js'
