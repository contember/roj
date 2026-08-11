import { describe, expect, test } from 'bun:test'
import { EXCLUDE_FILE, IGNORE_FILE, createIgnoreMatcher } from './ignore.js'

/** `files` maps a repo-relative path to its contents; everything else is absent. */
function matcher(files: Record<string, string>) {
	const sources = new Set<string>()
	for (const path of Object.keys(files)) {
		if (path === IGNORE_FILE) sources.add('')
		else if (path.endsWith(`/${IGNORE_FILE}`)) sources.add(path.slice(0, -(IGNORE_FILE.length + 1)))
	}
	return createIgnoreMatcher({ read: async (path) => files[path], sources })
}

describe('createIgnoreMatcher', () => {
	test('reports nothing ignored when there are no rules', async () => {
		expect(await matcher({}).isIgnored('src/index.ts')).toBe(false)
	})

	test('matches a bare name at any depth', async () => {
		const ignore = matcher({ [IGNORE_FILE]: 'node_modules\n' })
		expect(await ignore.isIgnored('node_modules/react/index.js')).toBe(true)
		expect(await ignore.isIgnored('packages/app/node_modules/react/index.js')).toBe(true)
		expect(await ignore.isIgnored('src/node_modules.ts')).toBe(false)
	})

	test('anchors a pattern that carries a separator', async () => {
		const ignore = matcher({ [IGNORE_FILE]: '/dist\nbuild/out\n' })
		expect(await ignore.isIgnored('dist/app.js')).toBe(true)
		expect(await ignore.isIgnored('packages/dist/app.js')).toBe(false)
		expect(await ignore.isIgnored('build/out/app.js')).toBe(true)
		expect(await ignore.isIgnored('nested/build/out/app.js')).toBe(false)
	})

	test('keeps a directory-only rule off a file of the same name', async () => {
		const ignore = matcher({ [IGNORE_FILE]: 'cache/\n' })
		expect(await ignore.isIgnored('cache/data.json')).toBe(true)
		expect(await ignore.isIgnored('cache')).toBe(false)
	})

	test('stops a single star at a separator and lets a double star cross one', async () => {
		const ignore = matcher({ [IGNORE_FILE]: 'logs/*.log\nassets/**/*.png\n' })
		expect(await ignore.isIgnored('logs/today.log')).toBe(true)
		expect(await ignore.isIgnored('logs/2026/today.log')).toBe(false)
		expect(await ignore.isIgnored('assets/a.png')).toBe(true)
		expect(await ignore.isIgnored('assets/icons/social/a.png')).toBe(true)
	})

	test('matches everything inside a trailing double star', async () => {
		const ignore = matcher({ [IGNORE_FILE]: 'vendor/**\n' })
		expect(await ignore.isIgnored('vendor/a.js')).toBe(true)
		expect(await ignore.isIgnored('vendor/deep/a.js')).toBe(true)
		expect(await ignore.isIgnored('vendored.js')).toBe(false)
	})

	test('lets a later line take a path back', async () => {
		const ignore = matcher({ [IGNORE_FILE]: '*.log\n!keep.log\n' })
		expect(await ignore.isIgnored('debug.log')).toBe(true)
		expect(await ignore.isIgnored('keep.log')).toBe(false)
	})

	// git: "It is not possible to re-include a file if a parent directory of that
	// file is excluded." A matcher that missed this would report every file a dev
	// server writes under an ignored directory.
	test('refuses to re-include below an excluded directory', async () => {
		const ignore = matcher({ [IGNORE_FILE]: 'build/\n!build/keep.txt\n' })
		expect(await ignore.isIgnored('build/keep.txt')).toBe(true)
	})

	test('lets a deeper file override a shallower one', async () => {
		const ignore = matcher({
			[IGNORE_FILE]: '*.tmp\n',
			[`src/${IGNORE_FILE}`]: '!*.tmp\n',
		})
		expect(await ignore.isIgnored('doc/a.tmp')).toBe(true)
		expect(await ignore.isIgnored('src/a.tmp')).toBe(false)
	})

	test('reads a nested file relative to its own directory', async () => {
		const ignore = matcher({ [`packages/app/${IGNORE_FILE}`]: '/dist\n' })
		expect(await ignore.isIgnored('packages/app/dist/a.js')).toBe(true)
		expect(await ignore.isIgnored('packages/other/dist/a.js')).toBe(false)
	})

	test('applies .git/info/exclude at the root', async () => {
		const ignore = matcher({ [EXCLUDE_FILE]: '*.local\n' })
		expect(await ignore.isIgnored('config.local')).toBe(true)
	})

	test('lets a .gitignore override .git/info/exclude', async () => {
		const ignore = matcher({ [EXCLUDE_FILE]: '*.local\n', [IGNORE_FILE]: '!config.local\n' })
		expect(await ignore.isIgnored('config.local')).toBe(false)
	})

	test('skips comments and blank lines', async () => {
		const ignore = matcher({ [IGNORE_FILE]: '# a comment\n\n   \n*.log\n' })
		expect(await ignore.isIgnored('a.log')).toBe(true)
		expect(await ignore.isIgnored('# a comment')).toBe(false)
	})

	test('honours a question mark and a character class', async () => {
		const ignore = matcher({ [IGNORE_FILE]: 'a?.txt\n[abc].md\n' })
		expect(await ignore.isIgnored('ax.txt')).toBe(true)
		expect(await ignore.isIgnored('axy.txt')).toBe(false)
		expect(await ignore.isIgnored('b.md')).toBe(true)
		expect(await ignore.isIgnored('d.md')).toBe(false)
	})

	test('takes a leading double star as any number of directories', async () => {
		const ignore = matcher({ [IGNORE_FILE]: '**/generated\n' })
		expect(await ignore.isIgnored('generated/a.ts')).toBe(true)
		expect(await ignore.isIgnored('src/deep/generated/a.ts')).toBe(true)
	})

	// `[[:alpha:]]` is a class of letters to git and a class of `[`, `:` and those
	// letters to a JS regex — a silently different answer, so the line is dropped.
	test('drops a POSIX class rather than translating it into a different one', async () => {
		const ignore = matcher({ [IGNORE_FILE]: '[[:alpha:]].md\n*.log\n' })
		expect(await ignore.isIgnored('a.md')).toBe(false)
		expect(await ignore.isIgnored('[.md')).toBe(false)
		expect(await ignore.isIgnored('a.log')).toBe(true)
	})

	test('drops a pattern it cannot express rather than the file it came in', async () => {
		const ignore = matcher({ [IGNORE_FILE]: '[unclosed\n*.log\n' })
		expect(await ignore.isIgnored('a.log')).toBe(true)
	})

	test('treats a name with regex punctuation literally', async () => {
		const ignore = matcher({ [IGNORE_FILE]: 'a+b(c).txt\n' })
		expect(await ignore.isIgnored('a+b(c).txt')).toBe(true)
		expect(await ignore.isIgnored('aab_c_.txt')).toBe(false)
	})
})
