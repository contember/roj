import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const assertReleaseAncestry = ({ commit, releaseRef = 'origin/main', cwd = process.cwd(), runner } = {}) => {
	if (!commit) throw new Error('Release commit is required')
	const run = runner ?? ((args) => spawnSync('git', args, { cwd, encoding: 'utf8' }))
	const result = run(['merge-base', '--is-ancestor', commit, releaseRef])
	if (result.error) throw result.error
	if (result.status === 0) return
	if (result.status === 1) throw new Error(`Release commit ${commit} is not reachable from ${releaseRef}`)
	throw new Error(`Could not verify release ancestry against ${releaseRef}: ${result.stderr.trim() || `git exited ${result.status}`}`)
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
	const commit = process.argv[2]
	const releaseRef = process.argv[3] ?? process.env.ROJ_RELEASE_REF ?? 'origin/main'
	assertReleaseAncestry({ commit, releaseRef })
	console.log(`Verified release commit ${commit} is reachable from ${releaseRef}`)
}
