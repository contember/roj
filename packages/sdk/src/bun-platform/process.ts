/**
 * Bun/Node ProcessRunner adapter — thin wrapper over `node:child_process`.
 */

import { type ChildProcess, execFile as execFileCb, spawn as nodeSpawn } from 'node:child_process'
import { promisify } from 'node:util'
import type { ProcessRunner } from '../platform/index.js'

const execFileP = promisify(execFileCb)

export function createBunProcessRunner(): ProcessRunner {
	return {
		async execFile(file, args, options) {
			const { stdout, stderr } = await execFileP(file, args, options ?? {})
			return {
				stdout: typeof stdout === 'string' ? stdout : Buffer.from(stdout).toString(),
				stderr: typeof stderr === 'string' ? stderr : Buffer.from(stderr).toString(),
			}
		},

		spawn(command, args, options): ChildProcess {
			return nodeSpawn(command, args, options ?? {})
		},
	}
}
