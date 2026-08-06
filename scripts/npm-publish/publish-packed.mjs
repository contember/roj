import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	discoverWorkspacePackages,
	publishedDependencyFields,
	topologicallySortWorkspacePackages,
} from './workspace-plan.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '../..')
const manifestInput = process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? process.env.PACKAGE_TARBALL_MANIFEST
if (!manifestInput) throw new Error('PACKAGE_TARBALL_MANIFEST is required')
const manifestPath = path.resolve(manifestInput)

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
if (manifest.schemaVersion !== 1 || !manifest.validatedAt || !Array.isArray(manifest.packages)) {
	throw new Error(`Invalid validated tarball manifest: ${manifestPath}`)
}

const workspaces = await discoverWorkspacePackages(repoRoot)
const publishOrder = topologicallySortWorkspacePackages(workspaces, {
	fields: publishedDependencyFields,
	publicOnly: true,
})
const expectedNames = publishOrder.map(({ pkg }) => pkg.name)
const actualNames = manifest.packages.map(({ name }) => name)
if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
	throw new Error(`Tarball manifest package order mismatch\nExpected: ${expectedNames.join(', ')}\nActual: ${actualNames.join(', ')}`)
}
if (new Set(actualNames).size !== actualNames.length) throw new Error('Tarball manifest contains duplicate packages')

for (let index = 0; index < publishOrder.length; index++) {
	const workspace = publishOrder[index]
	const packed = manifest.packages[index]
	if (packed.dir !== workspace.dir || packed.version !== workspace.pkg.version) {
		throw new Error(`Tarball manifest entry does not match ${workspace.pkg.name}`)
	}
	await stat(packed.tarball)
	const actualHash = createHash('sha256').update(await readFile(packed.tarball)).digest('hex')
	if (actualHash !== packed.sha256) throw new Error(`Validated tarball changed after validation: ${packed.tarball}`)
}

console.log(`Verified ${manifest.packages.length} validated tarballs before publishing`)
if (process.argv.includes('--check')) process.exit(0)

const npmTag = process.env.NPM_TAG ?? 'latest'
for (const entry of manifest.packages) {
	console.log(`\n→ Publishing ${entry.name} (tag: ${npmTag})`)
	const result = spawnSync('npm', ['publish', entry.tarball, '--tag', npmTag, '--access', 'public', '--provenance'], {
		stdio: 'inherit',
	})
	if (result.error) throw result.error
	if (result.status !== 0) throw new Error(`npm publish failed for ${entry.name}`)
}
