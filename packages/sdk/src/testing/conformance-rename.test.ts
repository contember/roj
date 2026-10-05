import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBunFileSystem } from '~/bun-platform/fs.js'
import type { FileSystem } from '~/platform/fs.js'
import { checksFor, probePlatformPorts, runConformanceCheck, type ConformanceTarget } from './conformance.js'
import { createNodeFileSystem, createNodePlatform } from './node-platform.js'

function target(name: string, fs: () => FileSystem): ConformanceTarget {
	return {
		name,
		async create() {
			const root = await mkdtemp(join(tmpdir(), 'roj-rename-'))
			return {
				root,
				platform: { ...createNodePlatform(), fs: fs() },
				dispose: () => rm(root, { recursive: true, force: true }),
			}
		},
	}
}

for (const adapter of [target('node rename', createNodeFileSystem), target('bun rename', createBunFileSystem)]) {
	describe(adapter.name, () => {
		test('reports the optional rename capability', async () => {
			const ports = await probePlatformPorts(adapter)
			expect(ports.find((port) => port.port === 'fs.rename')?.answered).toBe(true)
		})
		for (const check of checksFor(['fs.rename'])) {
			test(check.name, () => runConformanceCheck(adapter, check))
		}
	})
}

test('reports absent rename without requiring it from every platform', async () => {
	const adapter = target('no rename', () => ({ ...createNodeFileSystem(), rename: undefined }))
	const ports = await probePlatformPorts(adapter)
	expect(ports.find((port) => port.port === 'fs.rename')).toMatchObject({ answered: false })
})
