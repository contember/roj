/**
 * Test-only Platform impl backed by `node:fs/promises` + `node:child_process`.
 *
 * Mirrors the production adapter from `@roj-ai/sdk/bun-platform` but lives in this
 * package so tests don't create a workspace cycle. Production SDK code MUST
 * NOT import from here — use injected `Platform` from the caller instead.
 */

import { type ChildProcess, execFile as execFileCb, spawn as nodeSpawn } from 'node:child_process'
import * as fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import type { FileSystem, Platform, ProcessRunner } from '~/platform/index.js'

const execFileP = promisify(execFileCb)

export function createNodeFileSystem(): FileSystem {
	return {
		readFile: ((path: string, encoding?: 'utf-8' | 'utf8') =>
			encoding ? fsp.readFile(path, encoding) : fsp.readFile(path)) as FileSystem['readFile'],

		writeFile: (path, data) => fsp.writeFile(path, data),
		appendFile: (path, data) => fsp.appendFile(path, data),

		mkdir: async (path, options) => {
			await fsp.mkdir(path, options)
		},

		readdir: ((path: string, options?: { withFileTypes: true }) =>
			options?.withFileTypes
				? fsp.readdir(path, { withFileTypes: true })
				: fsp.readdir(path)) as FileSystem['readdir'],

		stat: (path) => fsp.stat(path),
		access: (path, mode) => fsp.access(path, mode),

		unlink: (path) => fsp.unlink(path),
		rm: (path, options) => fsp.rm(path, options),
		cp: async (source, dest, options) => {
			await fsp.cp(source, dest, options)
		},

		open: (path, flags) => fsp.open(path, flags),

		exists: async (path) => {
			try {
				await fsp.access(path)
				return true
			} catch {
				return false
			}
		},

		realpath: (path) => fsp.realpath(path),
	}
}

export function createNodeProcessRunner(): ProcessRunner {
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

export function createNodePlatform(): Platform {
	return {
		fs: createNodeFileSystem(),
		process: createNodeProcessRunner(),
		tmpDir: tmpdir(),
	}
}
