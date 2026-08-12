import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const tempDirs = []

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const createTempDir = async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'roj-release-entrypoint-test-'))
	tempDirs.push(dir)
	return dir
}

describe('release entrypoints', () => {
	test('run.sh verifies ancestry before delegating to the publisher', async () => {
		const tempDir = await createTempDir()
		const binDir = path.join(tempDir, 'bin')
		const logPath = path.join(tempDir, 'node-calls.log')
		await mkdir(binDir)
		const fakeNode = path.join(binDir, 'node')
		await writeFile(fakeNode, '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$ROJ_NODE_CALL_LOG"\n')
		await chmod(fakeNode, 0o755)

		const result = spawnSync('bash', ['./scripts/npm-publish/run.sh'], {
			cwd: repoRoot,
			encoding: 'utf8',
			env: {
				...process.env,
				GITHUB_SHA: 'release-commit',
				PACKAGE_TARBALL_MANIFEST: '/validated/manifest.json',
				PATH: `${binDir}:${process.env.PATH}`,
				ROJ_NODE_CALL_LOG: logPath,
				ROJ_RELEASE_REF: 'origin/release-main',
			},
		})
		expect(result.status).toBe(0)
		expect((await readFile(logPath, 'utf8')).trim().split('\n')).toEqual([
			'./scripts/npm-publish/check-release-ancestry.mjs release-commit origin/release-main',
			'./scripts/npm-publish/publish-packed.mjs /validated/manifest.json',
		])
	})

	test('direct publishing and bootstrap cannot bypass ancestry verification', async () => {
		const [publisher, bootstrap] = await Promise.all([
			readFile(path.join(repoRoot, 'scripts/npm-publish/publish-packed.mjs'), 'utf8'),
			readFile(path.join(repoRoot, 'scripts/npm-publish/init.sh'), 'utf8'),
		])
		expect(publisher.indexOf('assertReleaseAncestry({')).toBeGreaterThan(-1)
		expect(publisher.indexOf('assertReleaseAncestry({')).toBeLessThan(publisher.indexOf('decidePublish(entry, npmTag)'))
		expect(bootstrap.indexOf('check-release-ancestry.mjs')).toBeGreaterThan(-1)
		expect(bootstrap.indexOf('check-release-ancestry.mjs')).toBeLessThan(bootstrap.indexOf('npm whoami'))
	})
})
