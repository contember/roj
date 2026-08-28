#!/usr/bin/env bun
/**
 * Symlink a local `kompjutr` checkout into `node_modules/`.
 *
 * `@roj-ai/kompjutr-platform` builds against kompjutr, which is not on npm yet,
 * so no manifest can name a version that resolves. The symlink is the source of
 * truth until it publishes — and because bun installs nothing for a symlinked
 * directory, kompjutr's own devDependencies (wrangler, miniflare) stay out of
 * this repo's tree.
 *
 * Re-run after `bun install`, which removes it. kompjutr's `dist` must be built
 * (`npm run build` there); this script checks and says so rather than failing
 * later at an import.
 *
 *   bun run scripts/link-kompjutr.ts [path-to-kompjutr]
 */
import { existsSync, lstatSync, readFileSync, symlinkSync, unlinkSync } from 'node:fs'
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

const name = (JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')) as { name?: string }).name
if (name !== 'kompjutr') {
	console.error(`${target} is "${name}", not kompjutr.`)
	process.exit(1)
}

const link = join(repoRoot, 'node_modules', 'kompjutr')
if (existsSync(link) || lstatSync(link, { throwIfNoEntry: false })) unlinkSync(link)
symlinkSync(target, link, 'dir')

console.log(`kompjutr -> ${target}`)
if (!existsSync(join(target, 'dist', 'index.js'))) {
	console.warn('dist/ is missing — run `npm run build` in the kompjutr checkout.')
}
