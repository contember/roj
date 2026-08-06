import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

export const dependencyFields = [
	'dependencies',
	'devDependencies',
	'peerDependencies',
	'optionalDependencies',
]

export const publishedDependencyFields = [
	'dependencies',
	'peerDependencies',
	'optionalDependencies',
]

export async function discoverWorkspacePackages(repoRoot) {
	const packagesDir = path.resolve(repoRoot, 'packages')
	const entries = await readdir(packagesDir, { withFileTypes: true })
	const packages = []

	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.isDirectory()) continue
		const packageJsonPath = path.join(packagesDir, entry.name, 'package.json')
		let source
		try {
			source = await readFile(packageJsonPath, 'utf8')
		} catch (error) {
			if (error?.code === 'ENOENT') continue
			throw error
		}
		const pkg = JSON.parse(source)
		if (!pkg.name) throw new Error(`${packageJsonPath} has no package name`)
		packages.push({
			dir: entry.name,
			absDir: path.join(packagesDir, entry.name),
			path: packageJsonPath,
			pkg,
		})
	}

	const names = new Set()
	for (const entry of packages) {
		if (names.has(entry.pkg.name)) throw new Error(`Duplicate workspace package name: ${entry.pkg.name}`)
		names.add(entry.pkg.name)
	}

	return packages
}

export function topologicallySortWorkspacePackages(packages, options = {}) {
	const fields = options.fields ?? dependencyFields
	const selected = options.publicOnly ? packages.filter(({ pkg }) => pkg.private !== true) : [...packages]
	const selectedByName = new Map(selected.map((entry) => [entry.pkg.name, entry]))
	const allByName = new Map(packages.map((entry) => [entry.pkg.name, entry]))
	const dependencies = new Map()

	for (const entry of selected) {
		const internal = new Set()
		for (const field of fields) {
			for (const dependencyName of Object.keys(entry.pkg[field] ?? {})) {
				if (!allByName.has(dependencyName)) continue
				if (!selectedByName.has(dependencyName)) {
					throw new Error(`${entry.pkg.name} ${field} references excluded workspace package ${dependencyName}`)
				}
				internal.add(dependencyName)
			}
		}
		dependencies.set(entry.pkg.name, [...internal].sort())
	}

	const result = []
	const visiting = new Set()
	const visited = new Set()

	const visit = (name, chain = []) => {
		if (visited.has(name)) return
		if (visiting.has(name)) throw new Error(`Workspace dependency cycle: ${[...chain, name].join(' -> ')}`)
		visiting.add(name)
		for (const dependencyName of dependencies.get(name) ?? []) {
			visit(dependencyName, [...chain, name])
		}
		visiting.delete(name)
		visited.add(name)
		result.push(selectedByName.get(name))
	}

	for (const entry of selected.sort((a, b) => a.dir.localeCompare(b.dir))) {
		visit(entry.pkg.name)
	}

	if (result.length !== selected.length || new Set(result.map(({ pkg }) => pkg.name)).size !== selected.length) {
		throw new Error('Workspace ordering did not include every selected package exactly once')
	}

	return result
}
