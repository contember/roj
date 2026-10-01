#!/usr/bin/env bun
/**
 * Symlink the `@kompjutr/*` packages of a local kompjutr checkout into `node_modules/`.
 *
 * `@roj-ai/kompjutr-platform` builds against kompjutr, which is not on npm yet,
 * so no manifest can name a version that resolves. The symlink is the source of
 * truth until it publishes — and because bun installs nothing for a symlinked
 * directory, kompjutr's own devDependencies (wrangler, miniflare) stay out of
 * this repo's tree. A linked package resolves its sibling `@kompjutr/*`
 * dependencies through the checkout's own workspace `node_modules`.
 *
 * Re-run after `bun install`, which removes them. kompjutr's `dist` must be built
 * (`npm run build` there); this script checks and says so rather than failing
 * later at an import.
 *
 *   bun run scripts/link-kompjutr.ts [path-to-kompjutr]
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))

/** A worktree sits one level deeper than the main checkout, so guess both. */
const candidates = process.argv[2]
	? [resolve(process.argv[2])]
	: [join(repoRoot, '../../oss/kompjutr'), join(repoRoot, '../../../oss/kompjutr')].map((path) => resolve(path))

const target = candidates.find((path) => existsSync(join(path, 'package.json')))
if (target === undefined) {
	console.error(`No kompjutr checkout found. Looked in:\n${candidates.map((path) => `  ${path}`).join('\n')}`)
	console.error('Pass the path as an argument.')
	process.exit(1)
}

/** The packages this repo imports; add one here when a new import needs it. */
const packages = ['do']

const workspaceName = (
	JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')) as {
		name?: string
	}
).name
if (workspaceName !== 'kompjutr-workspace') {
	console.error(`${target} is "${workspaceName}", not the kompjutr workspace.`)
	process.exit(1)
}

const scopeDir = join(repoRoot, 'node_modules', '@kompjutr')
mkdirSync(scopeDir, { recursive: true })

for (const pkg of packages) {
	const packageDir = join(target, 'packages', pkg)
	const name = (
		JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
			name?: string
		}
	).name
	if (name !== `@kompjutr/${pkg}`) {
		console.error(`${packageDir} is "${name}", not @kompjutr/${pkg}.`)
		process.exit(1)
	}

	const link = join(scopeDir, pkg)
	if (existsSync(link) || lstatSync(link, { throwIfNoEntry: false })) unlinkSync(link)
	symlinkSync(packageDir, link, 'dir')

	console.log(`@kompjutr/${pkg} -> ${packageDir}`)
	if (!existsSync(join(packageDir, 'dist', 'index.js'))) {
		console.warn(`${pkg}/dist/ is missing — run \`npm run build\` in the kompjutr checkout.`)
	}
}
