import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	discoverWorkspacePackages,
	dependencyFields,
	publishedDependencyFields,
	topologicallySortWorkspacePackages,
} from './workspace-plan.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '../..')
const workspaces = await discoverWorkspacePackages(repoRoot)
const publishOrder = topologicallySortWorkspacePackages(workspaces, {
	fields: publishedDependencyFields,
	publicOnly: true,
})

if (process.argv.includes('--check-order')) {
	console.log(publishOrder.map(({ pkg }) => pkg.name).join('\n'))
	process.exit(0)
}

const packRoot = process.env.ROJ_PACK_DIR
	? path.resolve(process.env.ROJ_PACK_DIR)
	: await mkdtemp(path.join(tmpdir(), 'roj-npm-pack-'))
const tarballDir = path.join(packRoot, 'tarballs')
const consumerDir = await mkdtemp(path.join(tmpdir(), 'roj-npm-consumer-'))
await mkdir(tarballDir, { recursive: true })

const run = (command, args, options = {}) => {
	const result = spawnSync(command, args, { stdio: 'inherit', ...options })
	if (result.error) throw result.error
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}`)
	}
}

const sha256File = async (filePath) => createHash('sha256').update(await readFile(filePath)).digest('hex')

const packed = []
for (const workspace of publishOrder) {
	const version = workspace.pkg.version
	if (!version || version === '0.0.0') throw new Error(`${workspace.pkg.name} has invalid publish version ${version ?? '(missing)'}`)
	for (const field of dependencyFields) {
		for (const [name, value] of Object.entries(workspace.pkg[field] ?? {})) {
			if (typeof value === 'string' && (value.startsWith('workspace:') || value.startsWith('catalog:'))) {
				throw new Error(`${workspace.pkg.name} ${field}.${name} was not prepared for publishing: ${value}`)
			}
		}
	}

	const filename = `${workspace.dir}-${version}.tgz`
	const tarball = path.join(tarballDir, filename)
	run('bun', ['pm', 'pack', '--filename', tarball, '--quiet'], { cwd: workspace.absDir })
	await stat(tarball)
	packed.push({
		name: workspace.pkg.name,
		dir: workspace.dir,
		version,
		tarball,
		sha256: await sha256File(tarball),
	})
}

const rootPackage = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'))
const clientReact = workspaces.find(({ pkg }) => pkg.name === '@roj-ai/client-react')?.pkg
const consumerPackage = {
	name: 'roj-published-artifact-smoke',
	private: true,
	type: 'module',
	dependencies: Object.fromEntries(packed.map((entry) => [entry.name, `file:${entry.tarball}`])),
	devDependencies: {
		typescript: rootPackage.devDependencies.typescript,
		'@types/bun': rootPackage.workspaces.catalog['@types/bun'],
		'@types/react': clientReact?.devDependencies?.['@types/react'],
		'@types/react-dom': clientReact?.devDependencies?.['@types/react-dom'],
	},
}
await writeFile(path.join(consumerDir, 'package.json'), `${JSON.stringify(consumerPackage, null, '\t')}\n`)
run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'], { cwd: consumerDir })

const pathExists = async (target) => {
	try {
		await stat(target)
		return true
	} catch (error) {
		if (error?.code === 'ENOENT') return false
		throw error
	}
}

const collectTargets = (value, result = []) => {
	if (typeof value === 'string') result.push(value)
	else if (Array.isArray(value)) value.forEach((entry) => collectTargets(entry, result))
	else if (value && typeof value === 'object') Object.values(value).forEach((entry) => collectTargets(entry, result))
	return result
}

const findCompiledTests = async (dir, relative = '') => {
	if (!(await pathExists(dir))) return []
	const found = []
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const entryRelative = path.join(relative, entry.name)
		if (entry.isDirectory()) {
			if (entry.name === '__tests__') found.push(entryRelative)
			else found.push(...await findCompiledTests(path.join(dir, entry.name), entryRelative))
		} else if (/\.(?:test|spec)\.(?:[cm]?js|jsx|d\.ts)(?:\.map)?$/.test(entry.name)) {
			found.push(entryRelative)
		}
	}
	return found
}

const importSpecifiers = []
for (const entry of packed) {
	const installedDir = path.join(consumerDir, 'node_modules', ...entry.name.split('/'))
	const manifest = JSON.parse(await readFile(path.join(installedDir, 'package.json'), 'utf8'))
	if (manifest.name !== entry.name || manifest.version !== entry.version) {
		throw new Error(`Installed ${entry.name} does not match packed version ${entry.version}`)
	}

	const targets = new Set([
		...collectTargets(manifest.exports),
		...collectTargets(manifest.bin),
		...collectTargets(manifest.main),
		...collectTargets(manifest.types),
	])
	for (const target of targets) {
		if (!target.startsWith('./')) throw new Error(`${entry.name} has non-relative package target: ${target}`)
		if (target.includes('*')) throw new Error(`${entry.name} has an unvalidated wildcard package target: ${target}`)
		if (!(await pathExists(path.resolve(installedDir, target)))) {
			throw new Error(`${entry.name} package target does not exist: ${target}`)
		}
	}

	const compiledTests = await findCompiledTests(path.join(installedDir, 'dist'))
	if (compiledTests.length > 0) {
		throw new Error(`${entry.name} ships compiled tests:\n${compiledTests.map((file) => `  ${file}`).join('\n')}`)
	}

	for (const [binName, binTarget] of Object.entries(manifest.bin ?? {})) {
		const binPath = path.resolve(installedDir, binTarget)
		const firstLine = (await readFile(binPath, 'utf8')).split(/\r?\n/, 1)[0]
		if (!firstLine.startsWith('#!')) throw new Error(`${entry.name} bin ${binName} has no shebang`)
	}

	for (const [subpath, definition] of Object.entries(manifest.exports ?? {})) {
		const importTarget = typeof definition === 'string'
			? definition
			: definition?.import ?? definition?.default
		if (typeof importTarget !== 'string' || !/\.[cm]?js$/.test(importTarget)) continue
		importSpecifiers.push(subpath === '.' ? entry.name : `${entry.name}${subpath.slice(1)}`)
	}
}

const cliBin = path.join(consumerDir, 'node_modules', '.bin', 'roj-cli')
const cliTarget = await readFile(path.join(consumerDir, 'node_modules', '@roj-ai', 'cli', 'dist', 'main.js'), 'utf8')
if (!cliTarget.startsWith('#!/usr/bin/env bun\n')) throw new Error('@roj-ai/cli does not ship the Bun shebang')
run(cliBin, ['--help'], { cwd: consumerDir })
run(path.join(consumerDir, 'node_modules', '.bin', 'roj'), ['--help'], { cwd: consumerDir })

const uniqueImportSpecifiers = [...new Set(importSpecifiers)]
const esmSmokePath = path.join(consumerDir, 'esm-smoke.mjs')
await writeFile(esmSmokePath, `
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const specifiers = ${JSON.stringify(uniqueImportSpecifiers)}
for (const specifier of specifiers) await import(specifier)
const sdkPackageUrl = import.meta.resolve('@roj-ai/sdk/package.json')
const sdkPackage = JSON.parse(await readFile(fileURLToPath(sdkPackageUrl), 'utf8'))
assert.equal(sdkPackage.name, '@roj-ai/sdk')
`)
run('node', [esmSmokePath], { cwd: consumerDir })

const typeSmokePath = path.join(consumerDir, 'smoke.ts')
await writeFile(typeSmokePath, [
	...uniqueImportSpecifiers.map((specifier) => `import '${specifier}'`),
	`import sdkPackage from '@roj-ai/sdk/package.json' with { type: 'json' }`,
	`void sdkPackage`,
	'',
].join('\n'))
await writeFile(path.join(consumerDir, 'tsconfig.json'), `${JSON.stringify({
	compilerOptions: {
		allowSyntheticDefaultImports: true,
		lib: ['ES2022', 'DOM'],
		module: 'NodeNext',
		moduleResolution: 'NodeNext',
		noEmit: true,
		resolveJsonModule: true,
		skipLibCheck: false,
		strict: true,
		target: 'ES2022',
		types: ['bun', 'react', 'react-dom'],
	},
	include: ['smoke.ts'],
}, null, '\t')}\n`)
run(path.join(consumerDir, 'node_modules', '.bin', 'tsc'), ['--project', 'tsconfig.json'], { cwd: consumerDir })
await rm(consumerDir, { recursive: true, force: true })

const manifestPath = path.join(packRoot, 'manifest.json')
await writeFile(manifestPath, `${JSON.stringify({
	schemaVersion: 1,
	validatedAt: new Date().toISOString(),
	packages: packed,
}, null, '\t')}\n`)

if (process.env.GITHUB_ENV) {
	await appendFile(process.env.GITHUB_ENV, `PACKAGE_TARBALL_MANIFEST=${manifestPath}\n`)
}
console.log(`Validated ${packed.length} package tarballs: ${manifestPath}`)
