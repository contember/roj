#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
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
	run('bunx', ['tsc', '--build', `packages/${workspace.dir}`])
	run('bunx', ['tsc-alias', '-p', tsconfig, '--resolve-full-paths', '--resolve-full-extension', '.js'])
}
