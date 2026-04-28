/**
 * Bun/Node FileSystem adapter — thin wrapper over `node:fs/promises`.
 *
 * Bun's `node:fs/promises` is a full-fidelity polyfill; this module is thus
 * identical under Bun and Node runtimes.
 */

import * as fsp from 'node:fs/promises'
import type { FileSystem } from '../platform/index.js'

export function createBunFileSystem(): FileSystem {
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
