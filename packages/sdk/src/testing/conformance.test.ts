/**
 * The conformance suite against the in-repo `Platform`.
 *
 * `createNodePlatform` answers the three required ports plus `shell`; the rest
 * are legitimately absent, and the run names them so the gap is on the record
 * rather than implied by a green suite.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPlatformConformance } from './conformance.js'
import { createNodePlatform } from './node-platform.js'

runPlatformConformance({
	name: 'node platform',
	async create() {
		const root = await mkdtemp(join(tmpdir(), 'roj-conformance-'))
		return {
			platform: createNodePlatform(),
			root,
			dispose: () => rm(root, { recursive: true, force: true }),
		}
	},
})
