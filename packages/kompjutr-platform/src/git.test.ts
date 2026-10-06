import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createGit, Workspace } from '@kompjutr/do'
import { createKompjutrGitClient } from './git.js'
import { BunSqliteStorage } from './testing/storage.js'

let storage: BunSqliteStorage
let workspace: Workspace

beforeEach(async () => {
	storage = new BunSqliteStorage()
	workspace = new Workspace({ storage, git: createGit(), defaultGitIdentity: { name: 'Test', email: 'test@example.com' } })
	workspace.filesystem.mkdir('/repo')
	await workspace.git.init({ dir: '/repo', defaultBranch: 'main' })
})

afterEach(() => storage.close())

test('Git-only add and commit change status without advancing the upstream filesystem revision', async () => {
	const git = createKompjutrGitClient(workspace.git)
	workspace.fs.writeFileSync('/repo/note', 'content')
	const revision = workspace.filesystem.rev()
	expect(await git.status({ dir: '/repo' })).toEqual([{ path: 'note', index: ' ', worktree: '?' }])
	await workspace.git.add({ dir: '/repo', paths: ['note'] })
	expect(await git.status({ dir: '/repo' })).toEqual([{ path: 'note', index: 'A', worktree: ' ' }])
	await workspace.git.commit({ dir: '/repo', message: 'initial' })
	expect(await git.status({ dir: '/repo' })).toEqual([])
	expect(workspace.filesystem.rev()).toBe(revision)
})

test('defaultBranch preserves the full origin branch name, including slashes', async () => {
	const git = createKompjutrGitClient(workspace.git)
	expect(await git.defaultBranch({ dir: '/repo' })).toBeUndefined()
	for (const name of ['main', 'release/v1', 'team/release/v2']) {
		await workspace.git.updateRef({ dir: '/repo', ref: 'refs/remotes/origin/HEAD', value: `refs/remotes/origin/${name}`, symbolic: true, force: true })
		expect(await git.defaultBranch({ dir: '/repo' })).toBe(name)
	}
})

test('defaultBranch does not mistake other ref namespaces for an origin branch', async () => {
	const git = createKompjutrGitClient(workspace.git)
	for (const value of ['refs/remotes/upstream/main', 'refs/heads/main', 'refs/remotes/original/main']) {
		await workspace.git.updateRef({ dir: '/repo', ref: 'refs/remotes/origin/HEAD', value, symbolic: true, force: true })
		expect(await git.defaultBranch({ dir: '/repo' })).toBeUndefined()
	}
})
