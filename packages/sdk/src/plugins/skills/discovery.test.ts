import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { createNodeFileSystem } from '~/testing/node-platform.js'
import { discoverSkills, loadSkillContent, parseSkillFile, parseSkillFrontmatter } from './discovery.js'

const testFs = createNodeFileSystem()

// ============================================================================
// Test Setup
// ============================================================================

const TEST_DIR = path.join(import.meta.dir, '__test_skills__')

beforeEach(async () => {
	await mkdir(TEST_DIR, { recursive: true })
})

afterEach(async () => {
	await rm(TEST_DIR, { recursive: true, force: true })
})

// ============================================================================
// parseSkillFrontmatter tests
// ============================================================================

describe('parseSkillFrontmatter', () => {
	it('parses valid frontmatter with name and description', () => {
		const content = `---
name: research
description: Structured research workflow
---
# Research Skill
Some content here...`

		const result = parseSkillFrontmatter(content)
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.value.name).toBe('research')
			expect(result.value.description).toBe('Structured research workflow')
		}
	})

	it('parses quoted values', () => {
		const content = `---
name: "code-review"
description: 'Code review workflow'
---
Content...`

		const result = parseSkillFrontmatter(content)
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.value.name).toBe('code-review')
			expect(result.value.description).toBe('Code review workflow')
		}
	})

	it('fails when frontmatter does not start with ---', () => {
		const content = `name: research
description: Test
---
Content`

		const result = parseSkillFrontmatter(content)
		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.error.message).toContain('must start with ---')
		}
	})

	it('fails when closing --- is missing', () => {
		const content = `---
name: research
description: Test
Content without closing delimiter`

		const result = parseSkillFrontmatter(content)
		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.error.message).toContain('Missing closing ---')
		}
	})

	it('fails when name is missing', () => {
		const content = `---
description: Test description
---
Content`

		const result = parseSkillFrontmatter(content)
		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.error.message).toContain('Missing required "name"')
		}
	})

	it('fails when description is missing', () => {
		const content = `---
name: test-skill
---
Content`

		const result = parseSkillFrontmatter(content)
		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.error.message).toContain('Missing required "description"')
		}
	})

	it('ignores comments in frontmatter', () => {
		const content = `---
# This is a comment
name: test
description: Test skill
# Another comment
---
Content`

		const result = parseSkillFrontmatter(content)
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.value.name).toBe('test')
		}
	})
})

// ============================================================================
// parseSkillFile tests
// ============================================================================

describe('parseSkillFile', () => {
	it('extracts frontmatter and content separately', () => {
		const content = `---
name: research
description: Research workflow
---

# Research Skill

## When to Use
Use when searching for papers.`

		const result = parseSkillFile(content)
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.value.frontmatter.name).toBe('research')
			expect(result.value.frontmatter.description).toBe('Research workflow')
			expect(result.value.content).toContain('# Research Skill')
			expect(result.value.content).toContain('## When to Use')
			// Content should not include frontmatter
			expect(result.value.content).not.toContain('name:')
		}
	})

	it('handles minimal content', () => {
		const content = `---
name: minimal
description: Minimal skill
---
Just one line.`

		const result = parseSkillFile(content)
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.value.content).toBe('Just one line.')
		}
	})
})

// ============================================================================
// discoverSkills tests
// ============================================================================

describe('discoverSkills', () => {
	it('discovers skills from a directory', async () => {
		// Create skill directories
		const skillDir1 = path.join(TEST_DIR, 'research')
		const skillDir2 = path.join(TEST_DIR, 'code-review')
		await mkdir(skillDir1, { recursive: true })
		await mkdir(skillDir2, { recursive: true })

		await writeFile(
			path.join(skillDir1, 'SKILL.md'),
			`---
name: research
description: Research workflow
---
# Research content`,
		)

		await writeFile(
			path.join(skillDir2, 'SKILL.md'),
			`---
name: code-review
description: Code review process
---
# Code review content`,
		)

		const result = await discoverSkills(testFs, [TEST_DIR], '/')
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.value).toHaveLength(2)
			const names = result.value.map((s) => s.name)
			expect(names).toContain('research')
			expect(names).toContain('code-review')
		}
	})

	it('skips directories without SKILL.md', async () => {
		const skillDir = path.join(TEST_DIR, 'valid-skill')
		const otherDir = path.join(TEST_DIR, 'not-a-skill')
		await mkdir(skillDir, { recursive: true })
		await mkdir(otherDir, { recursive: true })

		await writeFile(
			path.join(skillDir, 'SKILL.md'),
			`---
name: valid
description: A valid skill
---
Content`,
		)

		await writeFile(path.join(otherDir, 'README.md'), 'Just a readme')

		const result = await discoverSkills(testFs, [TEST_DIR], '/')
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.value).toHaveLength(1)
			expect(result.value[0].name).toBe('valid')
		}
	})

	it('skips non-existent source directories', async () => {
		const result = await discoverSkills(testFs, ['/nonexistent/path'], '/')
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.value).toHaveLength(0)
		}
	})

	it('resolves relative paths from basePath', async () => {
		const baseDir = path.join(TEST_DIR, 'base')
		const skillsDir = path.join(baseDir, 'skills')
		const skillDir = path.join(skillsDir, 'my-skill')
		await mkdir(skillDir, { recursive: true })

		await writeFile(
			path.join(skillDir, 'SKILL.md'),
			`---
name: my-skill
description: A skill with relative path
---
Content`,
		)

		const result = await discoverSkills(testFs, ['skills'], baseDir)
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.value).toHaveLength(1)
			expect(result.value[0].name).toBe('my-skill')
		}
	})

	it('fails on duplicate skill IDs', async () => {
		const dir1 = path.join(TEST_DIR, 'skill1')
		const dir2 = path.join(TEST_DIR, 'skill2')
		await mkdir(dir1, { recursive: true })
		await mkdir(dir2, { recursive: true })

		// Both skills have the same name
		await writeFile(
			path.join(dir1, 'SKILL.md'),
			`---
name: duplicate
description: First skill
---
Content 1`,
		)

		await writeFile(
			path.join(dir2, 'SKILL.md'),
			`---
name: duplicate
description: Second skill
---
Content 2`,
		)

		const result = await discoverSkills(testFs, [TEST_DIR], '/')
		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.error.message).toContain('Duplicate skill ID')
		}
	})

	it('fails on invalid frontmatter', async () => {
		const skillDir = path.join(TEST_DIR, 'invalid-skill')
		await mkdir(skillDir, { recursive: true })

		await writeFile(
			path.join(skillDir, 'SKILL.md'),
			`---
name: invalid
# Missing description
---
Content`,
		)

		const result = await discoverSkills(testFs, [TEST_DIR], '/')
		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.error.message).toContain('Failed to parse')
		}
	})

	it('discovers skills from multiple source directories', async () => {
		const dir1 = path.join(TEST_DIR, 'source1')
		const dir2 = path.join(TEST_DIR, 'source2')
		const skill1 = path.join(dir1, 'skill-a')
		const skill2 = path.join(dir2, 'skill-b')
		await mkdir(skill1, { recursive: true })
		await mkdir(skill2, { recursive: true })

		await writeFile(
			path.join(skill1, 'SKILL.md'),
			`---
name: skill-a
description: First source skill
---
Content A`,
		)

		await writeFile(
			path.join(skill2, 'SKILL.md'),
			`---
name: skill-b
description: Second source skill
---
Content B`,
		)

		const result = await discoverSkills(testFs, [dir1, dir2], '/')
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.value).toHaveLength(2)
		}
	})
})

// ============================================================================
// loadSkillContent tests
// ============================================================================

describe('loadSkillContent', () => {
	it('loads skill content without frontmatter', async () => {
		const skillDir = path.join(TEST_DIR, 'load-test')
		await mkdir(skillDir, { recursive: true })

		const skillPath = path.join(skillDir, 'SKILL.md')
		await writeFile(
			skillPath,
			`---
name: loadable
description: A loadable skill
---

# Skill Instructions

## Step 1
Do something.

## Step 2
Do something else.`,
		)

		const result = await loadSkillContent(testFs, skillPath)
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.value).toContain('# Skill Instructions')
			expect(result.value).toContain('## Step 1')
			expect(result.value).not.toContain('name: loadable')
		}
	})

	it('fails for non-existent file', async () => {
		const result = await loadSkillContent(testFs, '/nonexistent/SKILL.md')
		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.error.message).toContain('not found')
		}
	})
})
