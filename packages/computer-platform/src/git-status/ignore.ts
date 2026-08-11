/**
 * `.gitignore`, as much of it as decides whether an untracked path is reported.
 *
 * The filesystem delta sees every write, including the ones into `node_modules`,
 * `dist` and a dev server's cache directory. `git status` does not report those,
 * so neither may this — without the ignore rules the count is wrong the moment
 * anything but the agent writes in the workspace.
 *
 * Only untracked paths ever reach here: a path the index already tracks is
 * reported whatever the ignore files say, which is git's own rule and is what
 * keeps this off the hot path.
 *
 * Precedence follows git: rules from a shallower `.gitignore` are applied first
 * and a deeper one overrides them, within a file the last matching line wins,
 * and a directory that is excluded excludes everything under it — no `!` line
 * deeper down can bring a file back.
 */

/** Rules from `.git/info/exclude` apply at the root, below every `.gitignore`. */
export const EXCLUDE_FILE = '.git/info/exclude'
export const IGNORE_FILE = '.gitignore'

interface CompiledPattern {
	negated: boolean
	/** `foo/` matches a directory and everything under it, never a file called `foo`. */
	dirOnly: boolean
	regex: RegExp
}

export interface IgnoreMatcherOptions {
	/** Reads a repo-relative file as text; `undefined` when it is not there. */
	read(path: string): Promise<string | undefined>
	/**
	 * Directories (repo-relative, `''` for the root) that hold a `.gitignore`.
	 * Taken from the tree listing the caller already has, so no directory is
	 * probed for a file that is known not to be there.
	 */
	sources: ReadonlySet<string>
}

export interface IgnoreMatcher {
	/** `path` is repo-relative and names a file. */
	isIgnored(path: string): Promise<boolean>
}

const REGEX_SPECIALS = new Set(['.', '+', '^', '$', '(', ')', '{', '}', '|', '\\', '[', ']', '*', '?'])

function escapeLiteral(char: string): string {
	return REGEX_SPECIALS.has(char) ? `\\${char}` : char
}

/** Git strips trailing whitespace from a pattern unless a backslash escapes it. */
function stripTrailingSpaces(line: string): string {
	let end = line.length
	while (end > 0) {
		const char = line[end - 1]
		if (char !== ' ' && char !== '\t') break
		let backslashes = 0
		for (let i = end - 2; i >= 0 && line[i] === '\\'; i--) backslashes++
		if (backslashes % 2 === 1) break
		end--
	}
	return line.slice(0, end)
}

/** End of a `[...]` class, or -1 when the bracket never closes. */
function findClassEnd(pattern: string, open: number): number {
	let index = open + 1
	if (pattern[index] === '!' || pattern[index] === '^') index++
	if (pattern[index] === ']') index++
	while (index < pattern.length) {
		const char = pattern[index]
		if (char === ']') return index
		if (char === '\\') index++
		index++
	}
	return -1
}

function translateClass(source: string): string {
	const body = source.slice(1, -1)
	return body.startsWith('!') ? `[^${body.slice(1)}]` : `[${body}]`
}

/**
 * Glob to regex body. `*` and `?` never cross a separator; `**` does, but only
 * where it stands as a whole path segment, which is git's rule.
 */
function translate(pattern: string): string {
	let out = ''
	let index = 0
	while (index < pattern.length) {
		const char = pattern[index]
		if (char === undefined) break

		if (char === '\\') {
			const next = pattern[index + 1]
			if (next === undefined) return `${out}\\\\`
			out += escapeLiteral(next)
			index += 2
			continue
		}

		if (char === '*' && pattern[index + 1] === '*') {
			const ownSegment = index === 0 || pattern[index - 1] === '/'
			const after = index + 2
			if (ownSegment && pattern[after] === '/') {
				out += '(?:[^/]+/)*'
				index = after + 1
				continue
			}
			if (ownSegment && after >= pattern.length) {
				// A trailing `/**` matches everything inside the directory.
				out += '.*'
				index = after
				continue
			}
			// Anywhere else `**` is no wider than `*`.
			out += '[^/]*'
			index = after
			continue
		}

		if (char === '*') {
			out += '[^/]*'
			index++
			continue
		}

		if (char === '?') {
			out += '[^/]'
			index++
			continue
		}

		if (char === '[') {
			const close = findClassEnd(pattern, index)
			if (close === -1) {
				out += '\\['
				index++
				continue
			}
			out += translateClass(pattern.slice(index, close + 1))
			index = close + 1
			continue
		}

		out += escapeLiteral(char)
		index++
	}
	return out
}

function compilePattern(line: string): CompiledPattern | undefined {
	let pattern = stripTrailingSpaces(line.replace(/\r$/, ''))
	if (pattern === '' || pattern.startsWith('#')) return undefined

	let negated = false
	if (pattern.startsWith('!')) {
		negated = true
		pattern = pattern.slice(1)
	} else if (pattern.startsWith('\\#') || pattern.startsWith('\\!')) {
		pattern = pattern.slice(1)
	}

	let dirOnly = false
	if (pattern.endsWith('/')) {
		dirOnly = true
		pattern = pattern.slice(0, -1)
	}
	if (pattern === '') return undefined

	// A POSIX class is valid in a gitignore and means something else inside a JS
	// character class, so the pattern is dropped rather than mistranslated into
	// one that silently matches the wrong paths.
	if (/\[:[a-z]+:\]/.test(pattern)) return undefined

	// A separator anywhere but the (already stripped) end anchors the pattern to
	// the directory its `.gitignore` sits in; otherwise it matches at any depth.
	const anchored = pattern.includes('/')
	if (pattern.startsWith('/')) pattern = pattern.slice(1)

	const body = translate(pattern)
	try {
		return { negated, dirOnly, regex: new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`) }
	} catch {
		// An unrepresentable pattern is dropped rather than allowed to reject the
		// whole file: one bad line must not turn every ignored path into a change.
		return undefined
	}
}

export function compileIgnoreFile(text: string): CompiledPattern[] {
	const patterns: CompiledPattern[] = []
	for (const line of text.split('\n')) {
		const compiled = compilePattern(line)
		if (compiled) patterns.push(compiled)
	}
	return patterns
}

/** `''`, then every directory down to the one holding `path`. */
function ancestorDirs(path: string): string[] {
	const dirs = ['']
	let cursor = path.indexOf('/')
	while (cursor !== -1) {
		dirs.push(path.slice(0, cursor))
		cursor = path.indexOf('/', cursor + 1)
	}
	return dirs
}

export function createIgnoreMatcher(options: IgnoreMatcherOptions): IgnoreMatcher {
	const { read, sources } = options
	const rules = new Map<string, CompiledPattern[]>()

	const rulesFor = async (dir: string): Promise<CompiledPattern[]> => {
		const cached = rules.get(dir)
		if (cached) return cached

		const loaded: CompiledPattern[] = []
		if (dir === '') {
			const exclude = await read(EXCLUDE_FILE)
			if (exclude !== undefined) loaded.push(...compileIgnoreFile(exclude))
		}
		if (sources.has(dir)) {
			const text = await read(dir === '' ? IGNORE_FILE : `${dir}/${IGNORE_FILE}`)
			if (text !== undefined) loaded.push(...compileIgnoreFile(text))
		}
		rules.set(dir, loaded)
		return loaded
	}

	/** Last match wins, shallowest file first. */
	const decide = async (candidate: string, isDir: boolean): Promise<boolean> => {
		let ignored = false
		for (const dir of ancestorDirs(candidate)) {
			const patterns = await rulesFor(dir)
			if (patterns.length === 0) continue
			const relative = dir === '' ? candidate : candidate.slice(dir.length + 1)
			for (const pattern of patterns) {
				if (pattern.dirOnly && !isDir) continue
				if (pattern.regex.test(relative)) ignored = !pattern.negated
			}
		}
		return ignored
	}

	return {
		async isIgnored(path: string): Promise<boolean> {
			const segments = path.split('/')
			// An excluded directory excludes its contents outright, so the ancestors
			// are asked first and a hit there ends it.
			for (let depth = 1; depth < segments.length; depth++) {
				if (await decide(segments.slice(0, depth).join('/'), true)) return true
			}
			return decide(path, false)
		},
	}
}
