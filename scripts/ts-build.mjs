#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverWorkspacePackages, topologicallySortWorkspacePackages } from './npm-publish/workspace-plan.mjs'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const workspaces = await discoverWorkspacePackages(repoRoot)
const buildOrder = topologicallySortWorkspacePackages(workspaces)

const run = (cmd, args) => {
	const r = spawnSync(cmd, args, { stdio: 'inherit' })
	if (r.status !== 0) process.exit(r.status ?? 1)
}

for (const workspace of buildOrder) {
	const tsconfig = join('packages', workspace.dir, 'tsconfig.json')
	if (!existsSync(tsconfig)) continue
	// A check-only project (no outDir) emits nothing, so it is not part of the
	// published build graph and there are no alias paths to resolve for it.
	if (!/"outDir"\s*:/.test(readFileSync(tsconfig, 'utf8'))) continue
	run('bunx', ['tsc', '--build', `packages/${workspace.dir}`])
	run('bunx', ['tsc-alias', '-p', tsconfig, '--resolve-full-paths', '--resolve-full-extension', '.js'])
}
