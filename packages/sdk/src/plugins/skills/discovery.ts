/**
 * Skill Discovery - Scans directories for SKILL.md files and parses frontmatter.
 *
 * Skills are discovered at preset load time. The system scans configured
 * source directories for subdirectories containing SKILL.md files.
 *
 * Expected directory structure:
 *   /skills/
 *     research/
 *       SKILL.md
 *     code-review/
 *       SKILL.md
 *
 * SKILL.md format:
 *   ---
 *   name: research
 *   description: Structured research workflow
 *   ---
 *   # Research Skill
 *   ...
 */

import * as path from 'node:path'
import type { Result } from '~/lib/utils/result.js'
import { Err, Ok } from '~/lib/utils/result.js'
import type { FileSystem } from '~/platform/fs.js'
import type { SkillMetadata } from '~/plugins/skills/schema.js'
import { SkillId } from '~/plugins/skills/schema.js'

// ============================================================================
// Types
// ============================================================================

export interface SkillDiscoveryError {
	type: 'discovery_error'
	message: string
	path?: string
}

export interface FrontmatterParseError {
	type: 'frontmatter_error'
	message: string
}

export interface ParsedFrontmatter {
	name: string
	description: string
}

export interface ParsedSkillFile {
	frontmatter: ParsedFrontmatter
	content: string
}

// ============================================================================
// Frontmatter Parsing
// ============================================================================

/**
 * Parse YAML frontmatter from a SKILL.md file content.
 * Returns the parsed name and description fields.
 *
 * Expected format:
 * ```
 * ---
 * name: skill-name
 * description: Short description
 * ---
 * # Content follows...
 * ```
 */
export function parseSkillFrontmatter(
	content: string,
): Result<ParsedFrontmatter, FrontmatterParseError> {
	// Check for frontmatter delimiters
	if (!content.startsWith('---')) {
		return Err({
			type: 'frontmatter_error',
			message: 'SKILL.md must start with --- frontmatter delimiter',
		})
	}

	// Find the closing delimiter
	const endIndex = content.indexOf('---', 3)
	if (endIndex === -1) {
		return Err({
			type: 'frontmatter_error',
			message: 'Missing closing --- frontmatter delimiter',
		})
	}

	const frontmatterBlock = content.slice(3, endIndex).trim()

	// Simple YAML parsing for name and description fields
	// Format: "key: value" on each line
	const lines = frontmatterBlock.split('\n')
	let name: string | undefined
	let description: string | undefined

	for (const line of lines) {
		const trimmed = line.trim()
		if (!trimmed || trimmed.startsWith('#')) continue

		const colonIndex = trimmed.indexOf(':')
		if (colonIndex === -1) continue

		const key = trimmed.slice(0, colonIndex).trim()
		let value = trimmed.slice(colonIndex + 1).trim()

		// Remove surrounding quotes if present
		if (
			(value.startsWith('"') && value.endsWith('"'))
			|| (value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1)
		}

		if (key === 'name') {
			name = value
		} else if (key === 'description') {
			description = value
		}
	}

	if (!name) {
		return Err({
			type: 'frontmatter_error',
			message: 'Missing required "name" field in frontmatter',
		})
	}

	if (!description) {
		return Err({
			type: 'frontmatter_error',
			message: 'Missing required "description" field in frontmatter',
		})
	}

	return Ok({ name, description })
}

/**
 * Parse a SKILL.md file, extracting frontmatter and content separately.
 */
export function parseSkillFile(
	fileContent: string,
): Result<ParsedSkillFile, FrontmatterParseError> {
	const frontmatterResult = parseSkillFrontmatter(fileContent)
	if (!frontmatterResult.ok) {
		return frontmatterResult
	}

	// Extract content after frontmatter
	const endIndex = fileContent.indexOf('---', 3)
	const content = fileContent.slice(endIndex + 3).trim()

	return Ok({
		frontmatter: frontmatterResult.value,
		content,
	})
}

// ============================================================================
// Skill Discovery
// ============================================================================

/**
 * Discover skills from configured source directories.
 * Scans each source directory for subdirectories containing SKILL.md files.
 */
export async function discoverSkills(
	fs: FileSystem,
	sources: string[],
	basePath: string,
): Promise<Result<SkillMetadata[], SkillDiscoveryError>> {
	const skills: SkillMetadata[] = []
	const seenIds = new Set<string>()

	for (const source of sources) {
		// Resolve source path (relative to basePath or absolute)
		const sourcePath = path.isAbsolute(source)
			? source
			: path.resolve(basePath, source)

		// Check if source directory exists
		if (!(await fs.exists(sourcePath))) {
			// Skip non-existent directories (not an error)
			continue
		}

		const stat = await fs.stat(sourcePath)
		if (!stat.isDirectory()) {
			return Err({
				type: 'discovery_error',
				message: `Skills source is not a directory`,
				path: sourcePath,
			})
		}

		// Scan for subdirectories containing SKILL.md
		const entries = await fs.readdir(sourcePath, { withFileTypes: true })

		for (const entry of entries) {
			if (!entry.isDirectory()) continue

			const skillDir = path.join(sourcePath, entry.name)
			const skillFile = path.join(skillDir, 'SKILL.md')

			if (!(await fs.exists(skillFile))) continue

			// Read and parse the skill file
			const content = await fs.readFile(skillFile, 'utf-8')
			const parseResult = parseSkillFrontmatter(content)

			if (!parseResult.ok) {
				return Err({
					type: 'discovery_error',
					message: `Failed to parse ${skillFile}: ${parseResult.error.message}`,
					path: skillFile,
				})
			}

			const { name, description } = parseResult.value
			const id = SkillId(name)

			// Check for duplicate skill IDs
			if (seenIds.has(id)) {
				return Err({
					type: 'discovery_error',
					message: `Duplicate skill ID: ${id}`,
					path: skillFile,
				})
			}
			seenIds.add(id)

			skills.push({
				source: 'file',
				id,
				name,
				description,
				sourcePath: skillFile,
			})
		}
	}

	return Ok(skills)
}

/**
 * Load the full content of a skill file (without frontmatter).
 */
export async function loadSkillContent(
	fs: FileSystem,
	skillPath: string,
): Promise<Result<string, SkillDiscoveryError>> {
	if (!(await fs.exists(skillPath))) {
		return Err({
			type: 'discovery_error',
			message: 'Skill file not found',
			path: skillPath,
		})
	}

	const content = await fs.readFile(skillPath, 'utf-8')
	const parseResult = parseSkillFile(content)

	if (!parseResult.ok) {
		return Err({
			type: 'discovery_error',
			message: parseResult.error.message,
			path: skillPath,
		})
	}

	return Ok(parseResult.value.content)
}
