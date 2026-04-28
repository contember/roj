import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const versionArg = process.argv[2]

if (!versionArg) {
	throw new Error('Version argument is required')
}

const match = versionArg.match(/^v?(\d+\.\d+\.\d+(?:-[a-z]+\.\d+)?)$/)
if (!match) {
	throw new Error(`Invalid version: ${versionArg}`)
}

const releaseVersion = match[1]
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../..')
const packagesDir = path.resolve(repoRoot, 'packages')
const dependencyFields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']

const rootPkg = JSON.parse(await readFile(path.resolve(repoRoot, 'package.json'), 'utf8'))
const defaultCatalog = rootPkg.workspaces?.catalog ?? {}
const namedCatalogs = rootPkg.workspaces?.catalogs ?? {}

const resolveCatalogRef = (depName, value) => {
	const spec = value.slice('catalog:'.length)
	const catalog = spec === '' ? defaultCatalog : namedCatalogs[spec]
	if (!catalog) {
		throw new Error(`Unknown catalog "${spec}" referenced by ${depName}`)
	}
	const resolved = catalog[depName]
	if (!resolved) {
		throw new Error(`Catalog "${spec || '(default)'}" has no entry for ${depName}`)
	}
	return resolved
}

const packageDirs = await readdir(packagesDir, { withFileTypes: true })
const packages = []

for (const entry of packageDirs) {
	if (!entry.isDirectory()) continue
	const packageJsonPath = path.join(packagesDir, entry.name, 'package.json')
	try {
		const source = await readFile(packageJsonPath, 'utf8')
		const pkg = JSON.parse(source)
		packages.push({ dir: entry.name, path: packageJsonPath, pkg })
	} catch {
		// Skip directories without package.json.
	}
}

const publicPackageNames = new Set(
	packages.filter(({ pkg }) => pkg.private !== true).map(({ pkg }) => pkg.name),
)

for (const entry of packages) {
	if (entry.pkg.private === true) continue

	entry.pkg.version = releaseVersion

	for (const field of dependencyFields) {
		const deps = entry.pkg[field]
		if (!deps) continue
		for (const [name, value] of Object.entries(deps)) {
			if (typeof value !== 'string') continue
			if (value.startsWith('workspace:')) {
				if (!publicPackageNames.has(name)) {
					throw new Error(`${entry.pkg.name} ${field}.${name} references private workspace package`)
				}
				deps[name] = `^${releaseVersion}`
			} else if (value.startsWith('catalog:')) {
				deps[name] = resolveCatalogRef(name, value)
			}
		}
	}

	await writeFile(entry.path, `${JSON.stringify(entry.pkg, null, '\t')}\n`)
}

console.log(`Prepared ${publicPackageNames.size} public packages for version ${releaseVersion}`)
