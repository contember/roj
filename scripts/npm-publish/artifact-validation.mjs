import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { compareSemver, parseSemver } from './release-policy.mjs'
import { dependencyFields, publishedDependencyFields } from './workspace-plan.mjs'

export const fileHashes = async (filePath) => {
	const contents = await readFile(filePath)
	return {
		sha256: createHash('sha256').update(contents).digest('hex'),
		integrity: `sha512-${createHash('sha512').update(contents).digest('base64')}`,
	}
}

export const assertPreparedDependencies = (workspace) => {
	for (const field of dependencyFields) {
		for (const [name, value] of Object.entries(workspace.pkg[field] ?? {})) {
			if (typeof value === 'string' && (value.startsWith('workspace:') || value.startsWith('catalog:'))) {
				throw new Error(`${workspace.pkg.name} ${field}.${name} was not prepared for publishing: ${value}`)
			}
		}
	}
}

export const validatePackedManifest = (entry, manifest) => {
	if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
		throw new Error(`${entry.name} packed package.json is not an object`)
	}
	if (manifest.name !== entry.name || manifest.version !== entry.version) {
		throw new Error(`Packed manifest does not match ${entry.name}@${entry.version}`)
	}
	for (const field of publishedDependencyFields) {
		const dependencies = manifest[field]
		if (dependencies === undefined) continue
		if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
			throw new Error(`${entry.name} packed ${field} is not an object`)
		}
		for (const [name, value] of Object.entries(dependencies)) {
			if (!name || typeof value !== 'string' || !value) {
				throw new Error(`${entry.name} packed ${field} has an invalid dependency entry`)
			}
		}
	}
	return manifest
}

export const readPackedManifest = (entry, runner = (args) => spawnSync('tar', args, { encoding: 'utf8' })) => {
	const result = runner(['-xOf', entry.tarball, 'package/package.json'])
	if (result.error) throw result.error
	if (result.status !== 0) {
		throw new Error(`Could not read package.json from ${entry.tarball}: ${result.stderr.trim() || `tar exited ${result.status}`}`)
	}
	let manifest
	try {
		manifest = JSON.parse(result.stdout)
	} catch {
		throw new Error(`${entry.name} packed package.json is invalid JSON`)
	}
	return validatePackedManifest(entry, manifest)
}

const satisfiesComparator = (candidate, operator, boundary) => {
	const comparison = compareSemver(candidate, boundary)
	switch (operator) {
		case '':
		case '=':
			return comparison === 0
		case '>':
			return comparison > 0
		case '>=':
			return comparison >= 0
		case '<':
			return comparison < 0
		case '<=':
			return comparison <= 0
		default:
			return false
	}
}

const parseSimpleRange = (range) => {
	if (/^(?:\*|[xX])$/.test(range)) return (candidate) => !parseSemver(candidate).prerelease
	const wildcard = range.match(/^(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$/)
	if (wildcard && (wildcard[2] === undefined || /[xX*]/.test(wildcard[2]) || wildcard[3] === undefined || /[xX*]/.test(wildcard[3]))) {
		const major = wildcard[1]
		if (wildcard[2] === undefined || /[xX*]/.test(wildcard[2])) {
			return (candidate) => {
				const parsed = parseSemver(candidate)
				return parsed.major === major && !parsed.prerelease
			}
		}
		const minor = wildcard[2]
		return (candidate) => {
			const parsed = parseSemver(candidate)
			return parsed.major === major && parsed.minor === minor && !parsed.prerelease
		}
	}

	const prefixed = range.match(/^([~^])\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/)
	if (prefixed) {
		const lower = prefixed[2]
		const parsedLower = parseSemver(lower)
		const upper = prefixed[1] === '~'
			? `${parsedLower.major}.${BigInt(parsedLower.minor) + 1n}.0`
			: parsedLower.major !== '0'
				? `${BigInt(parsedLower.major) + 1n}.0.0`
				: parsedLower.minor !== '0'
					? `0.${BigInt(parsedLower.minor) + 1n}.0`
					: `0.0.${BigInt(parsedLower.patch) + 1n}`
		return (candidate) => compareSemver(candidate, lower) >= 0
			&& compareSemver(candidate, upper) < 0
			&& (!parseSemver(candidate).prerelease || compareSemver(candidate, lower) === 0)
	}

	const exact = range.replace(/^=/, '')
	if (parseSemver(exact)) return (candidate) => compareSemver(candidate, exact) === 0

	const comparatorTokens = range.split(/\s+/)
	if (comparatorTokens.length > 0) {
		const comparators = comparatorTokens.map((token) => {
			const match = token.match(/^(<=|>=|<|>)(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/)
			if (!match) return undefined
			return { operator: match[1], boundary: match[2] }
		})
		if (comparators.every(Boolean)) {
			return (candidate) => comparators.every(({ operator, boundary }) => satisfiesComparator(candidate, operator, boundary))
				&& (!parseSemver(candidate).prerelease || comparators.some(({ boundary }) => {
					const parsedCandidate = parseSemver(candidate)
					const parsedBoundary = parseSemver(boundary)
					return parsedBoundary.prerelease && parsedCandidate.major === parsedBoundary.major
						&& parsedCandidate.minor === parsedBoundary.minor && parsedCandidate.patch === parsedBoundary.patch
				}))
		}
	}
	return undefined
}

export const validateInternalDependencySpec = (source, field, name, spec, dependencyVersion) => {
	if (/^(?:workspace|catalog|file|link|npm|https?|git(?:\+[^:]*)?):/i.test(spec) || /^(?:git@|github:|gitlab:|bitbucket:)/i.test(spec)) {
		throw new Error(`${source} packed ${field}.${name} uses unsupported internal dependency spec ${spec}`)
	}
	const candidate = parseSemver(dependencyVersion)
	if (!candidate) throw new Error(`${name} has invalid packed version ${dependencyVersion}`)
	const alternatives = spec.split('||').map((part) => part.trim())
	if (alternatives.some((part) => !part)) {
		throw new Error(`${source} packed ${field}.${name} uses unsupported internal dependency spec ${spec}`)
	}
	const predicates = alternatives.map(parseSimpleRange)
	if (predicates.some((predicate) => predicate === undefined)) {
		throw new Error(`${source} packed ${field}.${name} uses unsupported internal dependency spec ${spec}`)
	}
	if (!predicates.some((predicate) => predicate(dependencyVersion))) {
		throw new Error(`${source} packed ${field}.${name} requires ${name}@${spec}, but the packed version is ${dependencyVersion}`)
	}
}

export const buildPackedDependencyGraph = (packed, manifestsByName) => {
	const packedNames = new Set(packed.map(({ name }) => name))
	const graph = new Map()
	for (const entry of packed) {
		const manifest = validatePackedManifest(entry, manifestsByName.get(entry.name))
		const dependencies = []
		for (const field of publishedDependencyFields) {
			for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
				if (packedNames.has(name)) dependencies.push({ field, name, spec })
			}
		}
		graph.set(entry.name, dependencies.sort((left, right) => left.name.localeCompare(right.name)
			|| left.field.localeCompare(right.field) || left.spec.localeCompare(right.spec)))
	}
	const visiting = new Set()
	const visited = new Set()
	const visit = (name, chain = []) => {
		if (visiting.has(name)) throw new Error(`Packed dependency cycle: ${[...chain, name].join(' -> ')}`)
		if (visited.has(name)) return
		visiting.add(name)
		for (const dependency of graph.get(name) ?? []) visit(dependency.name, [...chain, name])
		visiting.delete(name)
		visited.add(name)
	}
	for (const name of [...graph.keys()].sort()) visit(name)
	return graph
}

export const collectInternalDependencyClosure = (targetName, graph) => {
	const result = []
	const visited = new Set([targetName])
	const visit = (name) => {
		if (visited.has(name)) return
		for (const dependency of graph.get(name) ?? []) visit(dependency.name)
		visited.add(name)
		result.push(name)
	}
	for (const dependency of graph.get(targetName) ?? []) visit(dependency.name)
	return result
}

export const createIsolatedInstallPlan = (entry, packedByName, graph) => {
	const overrides = {}
	const closure = collectInternalDependencyClosure(entry.name, graph)
	for (const source of [entry.name, ...closure]) {
		for (const { field, name, spec } of graph.get(source) ?? []) {
			const dependency = packedByName.get(name)
			if (!dependency) throw new Error(`Missing validated tarball for ${name}`)
			validateInternalDependencySpec(source, field, name, spec, dependency.version)
		}
	}
	for (const name of closure) {
		const dependency = packedByName.get(name)
		if (!dependency) throw new Error(`Missing validated tarball for ${name}`)
		overrides[name] = `file:${dependency.tarball}`
	}
	return {
		dependencies: { [entry.name]: `file:${entry.tarball}` },
		overrides,
	}
}

export const pathExists = async (target) => {
	try {
		await stat(target)
		return true
	} catch (error) {
		if (error?.code === 'ENOENT') return false
		throw error
	}
}

export const collectTargets = (value, result = []) => {
	if (typeof value === 'string') result.push(value)
	else if (Array.isArray(value)) value.forEach((entry) => collectTargets(entry, result))
	else if (value && typeof value === 'object') Object.values(value).forEach((entry) => collectTargets(entry, result))
	return result
}

/** Test sources can ship outside dist through source maps and declaration maps. */
export const findTestArtifacts = async (dir, relative = '') => {
	if (!(await pathExists(dir))) return []
	const found = []
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const entryRelative = path.join(relative, entry.name)
		if (entry.isDirectory()) {
			if (entry.name === 'node_modules') continue
			if (entry.name === '__tests__') found.push(entryRelative)
			else found.push(...await findTestArtifacts(path.join(dir, entry.name), entryRelative))
		} else if (/\.(?:test|spec)\.(?:[cm]?[jt]sx?|d\.ts)(?:\.map)?$/.test(entry.name)) {
			found.push(entryRelative)
		}
	}
	return found
}
