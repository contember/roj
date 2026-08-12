import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
	assertPreparedDependencies,
	buildPackedDependencyGraph,
	collectTargets,
	createIsolatedInstallPlan,
	fileHashes,
	findTestArtifacts,
	readPackedManifest,
	validateInternalDependencySpec,
	validatePackedManifest,
} from './artifact-validation.mjs'

const tempDirs = []

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const createTempDir = async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'roj-artifact-validation-test-'))
	tempDirs.push(dir)
	return dir
}

const run = (command, args, cwd) => {
	const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
	if (result.error) throw result.error
	if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr}`)
	return result.stdout.trim()
}

const writeFixturePackage = async (root, { name, dependencies = {}, source }) => {
	const dir = path.join(root, name.split('/').at(-1))
	await mkdir(dir, { recursive: true })
	await writeFile(path.join(dir, 'package.json'), `${JSON.stringify({
		name,
		version: '1.0.0',
		type: 'module',
		main: './index.js',
		dependencies,
	}, null, '\t')}\n`)
	await writeFile(path.join(dir, 'index.js'), source)
	return dir
}

describe('artifact validation', () => {
	test('records both tamper and npm-compatible integrity hashes', async () => {
		const dir = await createTempDir()
		const file = path.join(dir, 'package.tgz')
		await writeFile(file, 'artifact')

		expect(await fileHashes(file)).toEqual({
			sha256: 'c7c5c1d70c5dec4416ab6158afd0b223ef40c29b1dc1f97ed9428b94d4cadb1c',
			integrity: 'sha512-FGl0QHAcOIX3yNX6pZ8za0ccqGMyA07/DT/dwC3JsYuDVuhA21SCPI/S8svQkGlpzxMs+Lucc9x2m0/9gXvSPQ==',
		})
	})

	test('derives a deterministic transitive install plan from packed manifests', () => {
		const packed = [
			{ name: '@roj-ai/client', version: '1.0.0', tarball: '/packs/client.tgz' },
			{ name: '@roj-ai/shared', version: '1.0.0', tarball: '/packs/shared.tgz' },
			{ name: '@roj-ai/sdk', version: '1.0.0', tarball: '/packs/sdk.tgz' },
			{ name: '@roj-ai/transport', version: '1.0.0', tarball: '/packs/transport.tgz' },
			{ name: '@roj-ai/undeclared', version: '1.0.0', tarball: '/packs/undeclared.tgz' },
		]
		const manifests = new Map([
			['@roj-ai/client', { name: '@roj-ai/client', version: '1.0.0', dependencies: { '@roj-ai/shared': '^1.0.0' } }],
			['@roj-ai/shared', { name: '@roj-ai/shared', version: '1.0.0', dependencies: { '@roj-ai/sdk': '^1.0.0' } }],
			['@roj-ai/sdk', { name: '@roj-ai/sdk', version: '1.0.0', dependencies: { '@roj-ai/transport': '^1.0.0' } }],
			['@roj-ai/transport', { name: '@roj-ai/transport', version: '1.0.0' }],
			['@roj-ai/undeclared', { name: '@roj-ai/undeclared', version: '1.0.0' }],
		])
		const graph = buildPackedDependencyGraph(packed, manifests)
		expect(graph.get('@roj-ai/client')).toEqual([
			{ field: 'dependencies', name: '@roj-ai/shared', spec: '^1.0.0' },
		])

		expect(createIsolatedInstallPlan(packed[0], new Map(packed.map((entry) => [entry.name, entry])), graph)).toEqual({
			dependencies: { '@roj-ai/client': 'file:/packs/client.tgz' },
			overrides: {
				'@roj-ai/transport': 'file:/packs/transport.tgz',
				'@roj-ai/sdk': 'file:/packs/sdk.tgz',
				'@roj-ai/shared': 'file:/packs/shared.tgz',
			},
		})
	})

	test('installs a deep packed graph without exposing an undeclared transitive dependency', async () => {
		const root = await createTempDir()
		const packageRoot = path.join(root, 'packages')
		const packRoot = path.join(root, 'packs')
		const consumer = path.join(root, 'consumer')
		await Promise.all([mkdir(packageRoot), mkdir(packRoot), mkdir(consumer)])
		const fixturePackages = [
			{
				name: '@fixture/transport',
				source: `export const value = 'transport'\n`,
			},
			{
				name: '@fixture/sdk',
				dependencies: { '@fixture/transport': '^1.0.0' },
				source: `import { value } from '@fixture/transport'; export const sdk = value + ':sdk'\n`,
			},
			{
				name: '@fixture/shared',
				dependencies: { '@fixture/sdk': '^1.0.0' },
				source: `import { sdk } from '@fixture/sdk'; export const shared = sdk + ':shared'\n`,
			},
			{
				name: '@fixture/client',
				dependencies: { '@fixture/shared': '^1.0.0' },
				source: `import { shared } from '@fixture/shared'; export const value = shared + ':client'; export const loadTransitive = () => import('@fixture/sdk')\n`,
			},
			{
				name: '@fixture/undeclared',
				source: `export const leaked = true\n`,
			},
		]
		const sourceDirs = new Map()
		for (const fixturePackage of fixturePackages) {
			sourceDirs.set(fixturePackage.name, await writeFixturePackage(packageRoot, fixturePackage))
		}
		const packed = []
		for (const fixturePackage of fixturePackages) {
			const output = JSON.parse(run('npm', [
				'pack',
				sourceDirs.get(fixturePackage.name),
				'--json',
				'--ignore-scripts',
				'--pack-destination',
				packRoot,
			], root))
			packed.push({
				name: fixturePackage.name,
				version: '1.0.0',
				tarball: path.join(packRoot, output[0].filename),
			})
		}

		// Source drift after packing must not change the artifact dependency graph.
		const clientSourceManifestPath = path.join(sourceDirs.get('@fixture/client'), 'package.json')
		const clientSourceManifest = JSON.parse(await readFile(clientSourceManifestPath, 'utf8'))
		clientSourceManifest.dependencies = { '@fixture/undeclared': '^1.0.0' }
		await writeFile(clientSourceManifestPath, `${JSON.stringify(clientSourceManifest, null, '\t')}\n`)

		const manifests = new Map(packed.map((entry) => [entry.name, readPackedManifest(entry)]))
		const graph = buildPackedDependencyGraph(packed, manifests)
		const clientEntry = packed.find(({ name }) => name === '@fixture/client')
		const plan = createIsolatedInstallPlan(clientEntry, new Map(packed.map((entry) => [entry.name, entry])), graph)
		expect(plan.overrides).not.toHaveProperty('@fixture/undeclared')
		await writeFile(path.join(consumer, 'package.json'), `${JSON.stringify({
			name: 'fixture-consumer',
			private: true,
			type: 'module',
			...plan,
		}, null, '\t')}\n`)
		run('npm', [
			'install',
			'--offline',
			'--install-strategy=nested',
			'--ignore-scripts',
			'--no-audit',
			'--no-fund',
			'--package-lock=false',
		], consumer)
		await writeFile(path.join(consumer, 'verify.mjs'), `
import assert from 'node:assert/strict'
import { loadTransitive, value } from '@fixture/client'
assert.equal(value, 'transport:sdk:shared:client')
await assert.rejects(loadTransitive(), { code: 'ERR_MODULE_NOT_FOUND' })
`)
		run('node', ['verify.mjs'], consumer)
	}, { timeout: 20_000 })

	test('rejects packed internal dependency version mismatches', () => {
		const packed = [
			{ name: '@roj-ai/client', version: '1.0.0', tarball: '/packs/client.tgz' },
			{ name: '@roj-ai/shared', version: '1.0.0', tarball: '/packs/shared.tgz' },
		]
		const graph = buildPackedDependencyGraph(packed, new Map([
			['@roj-ai/client', { name: '@roj-ai/client', version: '1.0.0', dependencies: { '@roj-ai/shared': '^2.0.0' } }],
			['@roj-ai/shared', { name: '@roj-ai/shared', version: '1.0.0' }],
		]))

		expect(() => createIsolatedInstallPlan(
			packed[0],
			new Map(packed.map((entry) => [entry.name, entry])),
			graph,
		)).toThrow('requires @roj-ai/shared@^2.0.0, but the packed version is 1.0.0')
	})

	test('rejects unsupported packed internal dependency protocols', () => {
		for (const spec of ['workspace:*', 'catalog:', 'file:../shared', 'link:../shared', 'npm:other@^1.0.0']) {
			expect(() => validateInternalDependencySpec(
				'@roj-ai/client',
				'dependencies',
				'@roj-ai/shared',
				spec,
				'1.0.0',
			)).toThrow('uses unsupported internal dependency spec')
		}
	})

	test('accepts supported semver forms only when the packed version satisfies them', () => {
		for (const spec of ['1.2.3', '^1.2.0', '~1.2.0', '>=1.0.0 <2.0.0', '1.2.x', '^1.2.3 || ^2.0.0']) {
			expect(() => validateInternalDependencySpec(
				'@roj-ai/client',
				'dependencies',
				'@roj-ai/shared',
				spec,
				'1.2.3',
			)).not.toThrow()
		}
		expect(() => validateInternalDependencySpec(
			'@roj-ai/client',
			'dependencies',
			'@roj-ai/shared',
			'latest',
			'1.2.3',
		)).toThrow('uses unsupported internal dependency spec')
	})

	test('validates identity and dependency fields from packed manifests', () => {
		const entry = { name: '@roj-ai/client', version: '1.0.0' }
		expect(() => validatePackedManifest(entry, {
			name: '@roj-ai/other',
			version: '1.0.0',
		})).toThrow('does not match')
		expect(() => validatePackedManifest(entry, {
			name: '@roj-ai/client',
			version: '1.0.0',
			dependencies: [],
		})).toThrow('dependencies is not an object')
	})

	test('rejects dependency cycles found only in packed manifests', () => {
		const packed = [
			{ name: '@roj-ai/a', version: '1.0.0' },
			{ name: '@roj-ai/b', version: '1.0.0' },
		]
		expect(() => buildPackedDependencyGraph(packed, new Map([
			['@roj-ai/a', { name: '@roj-ai/a', version: '1.0.0', dependencies: { '@roj-ai/b': '^1.0.0' } }],
			['@roj-ai/b', { name: '@roj-ai/b', version: '1.0.0', dependencies: { '@roj-ai/a': '^1.0.0' } }],
		]))).toThrow('Packed dependency cycle')
	})

	test('rejects unprepared workspace and catalog references', () => {
		expect(() => assertPreparedDependencies({
			pkg: { name: '@roj-ai/a', dependencies: { '@roj-ai/b': 'workspace:*' } },
		})).toThrow('was not prepared for publishing')
		expect(() => assertPreparedDependencies({
			pkg: { name: '@roj-ai/a', devDependencies: { typescript: 'catalog:build' } },
		})).toThrow('was not prepared for publishing')
	})

	test('finds test artifacts anywhere in a packed tree', async () => {
		const dir = await createTempDir()
		await mkdir(path.join(dir, 'src', '__tests__'), { recursive: true })
		await mkdir(path.join(dir, 'dist'), { recursive: true })
		await writeFile(path.join(dir, 'src', 'worker.test.ts'), '')
		await writeFile(path.join(dir, 'dist', 'worker.spec.js.map'), '')

		expect((await findTestArtifacts(dir)).sort()).toEqual([
			path.join('dist', 'worker.spec.js.map'),
			path.join('src', '__tests__'),
			path.join('src', 'worker.test.ts'),
		].sort())
	})

	test('collects nested package targets', () => {
		expect(collectTargets({ '.': { import: './dist/index.js', types: './dist/index.d.ts' } })).toEqual([
			'./dist/index.js',
			'./dist/index.d.ts',
		])
	})
})
