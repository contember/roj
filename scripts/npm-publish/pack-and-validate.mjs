import { spawnSync } from 'node:child_process'
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	discoverWorkspacePackages,
	publishedDependencyFields,
	topologicallySortWorkspacePackages,
} from './workspace-plan.mjs'
import {
	assertPreparedDependencies,
	buildPackedDependencyGraph,
	collectTargets,
	createIsolatedInstallPlan,
	fileHashes,
	findTestArtifacts,
	pathExists,
	readPackedManifest,
} from './artifact-validation.mjs'

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
await mkdir(tarballDir, { recursive: true })

const run = (command, args, options = {}) => {
	const result = spawnSync(command, args, { stdio: 'inherit', ...options })
	if (result.error) throw result.error
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}`)
	}
}

const packed = []
for (const workspace of publishOrder) {
	const version = workspace.pkg.version
	if (!version || version === '0.0.0') throw new Error(`${workspace.pkg.name} has invalid publish version ${version ?? '(missing)'}`)
	assertPreparedDependencies(workspace)

	const filename = `${workspace.dir}-${version}.tgz`
	const tarball = path.join(tarballDir, filename)
	run('bun', ['pm', 'pack', '--filename', tarball, '--quiet'], { cwd: workspace.absDir })
	await stat(tarball)
	const hashes = await fileHashes(tarball)
	packed.push({
		name: workspace.pkg.name,
		dir: workspace.dir,
		version,
		tarball,
		...hashes,
	})
}

const rootPackage = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'))
const clientReact = workspaces.find(({ pkg }) => pkg.name === '@roj-ai/client-react')?.pkg
const packedByName = new Map(packed.map((entry) => [entry.name, entry]))
const packedManifests = new Map(packed.map((entry) => [entry.name, readPackedManifest(entry)]))
const packedDependencyGraph = buildPackedDependencyGraph(packed, packedManifests)
for (const entry of packed) {
	const consumerDir = await mkdtemp(path.join(tmpdir(), `roj-npm-consumer-${entry.dir}-`))
	const installPlan = createIsolatedInstallPlan(entry, packedByName, packedDependencyGraph)
	const consumerPackage = {
		name: `roj-published-artifact-smoke-${entry.dir}`,
		private: true,
		type: 'module',
		...installPlan,
		devDependencies: {
			typescript: rootPackage.devDependencies.typescript,
			'@types/bun': rootPackage.workspaces.catalog['@types/bun'],
			'@types/react': clientReact?.devDependencies?.['@types/react'],
			'@types/react-dom': clientReact?.devDependencies?.['@types/react-dom'],
		},
	}
	await writeFile(path.join(consumerDir, 'package.json'), `${JSON.stringify(consumerPackage, null, '\t')}\n`)
	// Nested layout preserves package-local visibility for the declared graph.
	run('npm', [
		'install',
		'--install-strategy=nested',
		'--ignore-scripts',
		'--no-audit',
		'--no-fund',
		'--package-lock=false',
	], { cwd: consumerDir })

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

	const testArtifacts = await findTestArtifacts(installedDir)
	if (testArtifacts.length > 0) {
		throw new Error(`${entry.name} ships tests:\n${testArtifacts.map((file) => `  ${file}`).join('\n')}`)
	}

	for (const [binName, binTarget] of Object.entries(manifest.bin ?? {})) {
		const binPath = path.resolve(installedDir, binTarget)
		const firstLine = (await readFile(binPath, 'utf8')).split(/\r?\n/, 1)[0]
		if (!firstLine.startsWith('#!')) throw new Error(`${entry.name} bin ${binName} has no shebang`)
	}

	const importSpecifiers = []
	for (const [subpath, definition] of Object.entries(manifest.exports ?? {})) {
		const importTarget = typeof definition === 'string'
			? definition
			: definition?.import ?? definition?.default
		if (typeof importTarget !== 'string' || !/\.[cm]?js$/.test(importTarget)) continue
		importSpecifiers.push(subpath === '.' ? entry.name : `${entry.name}${subpath.slice(1)}`)
	}

	if (entry.name === '@roj-ai/cli') {
		const cliTarget = await readFile(path.join(installedDir, 'dist', 'main.js'), 'utf8')
		if (!cliTarget.startsWith('#!/usr/bin/env bun\n')) throw new Error('@roj-ai/cli does not ship the Bun shebang')
		run(path.join(consumerDir, 'node_modules', '.bin', 'roj-cli'), ['--help'], { cwd: consumerDir })
	}
	if (entry.name === '@roj-ai/platform-cli') {
		run(path.join(consumerDir, 'node_modules', '.bin', 'roj'), ['--help'], { cwd: consumerDir })
	}

	const uniqueImportSpecifiers = [...new Set(importSpecifiers)]
	const esmSmokePath = path.join(consumerDir, 'esm-smoke.mjs')
	await writeFile(esmSmokePath, `
const specifiers = ${JSON.stringify(uniqueImportSpecifiers)}
for (const specifier of specifiers) await import(specifier)
`)
	run('node', [esmSmokePath], { cwd: consumerDir })

	const typeSmokePath = path.join(consumerDir, 'smoke.ts')
	await writeFile(typeSmokePath, [
		...uniqueImportSpecifiers.map((specifier) => `import '${specifier}'`),
		...(entry.name === '@roj-ai/sdk'
			? [`import packageManifest from '@roj-ai/sdk/package.json' with { type: 'json' }`, 'void packageManifest']
			: []),
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
}

const manifestPath = path.join(packRoot, 'manifest.json')
await writeFile(manifestPath, `${JSON.stringify({
	schemaVersion: 2,
	validatedAt: new Date().toISOString(),
	packages: packed,
}, null, '\t')}\n`)

if (process.env.GITHUB_ENV) {
	await appendFile(process.env.GITHUB_ENV, `PACKAGE_TARBALL_MANIFEST=${manifestPath}\n`)
}
console.log(`Validated ${packed.length} package tarballs: ${manifestPath}`)
