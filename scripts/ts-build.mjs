#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// Topological build order. Each package is built (tsc) and its dist
// has alias paths resolved (tsc-alias) before downstream packages compile,
// so consumers see fully-resolved relative paths in upstream .d.ts files.
const ORDER = [
	'transport',
	'sdk',
	'shared',
	'client',
	'sandbox-runtime',
	'platform-cli',
	'cli',
	'debug',
	'client-react',
	'standalone-server',
	'demo',
]

const run = (cmd, args) => {
	const r = spawnSync(cmd, args, { stdio: 'inherit' })
	if (r.status !== 0) process.exit(r.status ?? 1)
}

for (const pkg of ORDER) {
	const tsconfig = join('packages', pkg, 'tsconfig.json')
	if (!existsSync(tsconfig)) continue
	run('bunx', ['tsc', '--build', `packages/${pkg}`])
	run('bunx', ['tsc-alias', '-p', tsconfig])
}
