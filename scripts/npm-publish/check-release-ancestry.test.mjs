import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { assertReleaseAncestry } from './check-release-ancestry.mjs'

const tempDirs = []

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

const createRepository = async () => {
	const cwd = await mkdtemp(path.join(tmpdir(), 'roj-release-ancestry-test-'))
	tempDirs.push(cwd)
	git(cwd, 'init', '--initial-branch=main')
	git(cwd, 'config', 'user.name', 'Test User')
	git(cwd, 'config', 'user.email', 'test@example.com')
	await writeFile(path.join(cwd, 'release.txt'), 'main\n')
	git(cwd, 'add', 'release.txt')
	git(cwd, 'commit', '-m', 'main release')
	const mainCommit = git(cwd, 'rev-parse', 'HEAD')
	git(cwd, 'update-ref', 'refs/remotes/origin/main', mainCommit)
	return { cwd, mainCommit }
}

describe('release ancestry', () => {
	test('accepts a commit reachable from origin/main', async () => {
		const repository = await createRepository()
		expect(() => assertReleaseAncestry({
			commit: repository.mainCommit,
			releaseRef: 'origin/main',
			cwd: repository.cwd,
		})).not.toThrow()
	})

	test('rejects a feature-only commit', async () => {
		const repository = await createRepository()
		git(repository.cwd, 'switch', '-c', 'feature')
		await writeFile(path.join(repository.cwd, 'feature.txt'), 'feature\n')
		git(repository.cwd, 'add', 'feature.txt')
		git(repository.cwd, 'commit', '-m', 'feature release')
		const featureCommit = git(repository.cwd, 'rev-parse', 'HEAD')

		expect(() => assertReleaseAncestry({
			commit: featureCommit,
			releaseRef: 'origin/main',
			cwd: repository.cwd,
		})).toThrow('is not reachable')
	})

	test('reports a missing release ref as a verification error', async () => {
		const repository = await createRepository()
		expect(() => assertReleaseAncestry({
			commit: repository.mainCommit,
			releaseRef: 'origin/missing',
			cwd: repository.cwd,
		})).toThrow('Could not verify release ancestry')
	})
})
