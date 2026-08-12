import { posix, win32 } from 'node:path'
import z from 'zod/v4'

export function isResourceBasename(filename: string): boolean {
	return filename.length > 0
		&& !filename.includes('\0')
		&& !filename.includes('/')
		&& !filename.includes('\\')
		&& filename !== '.'
		&& filename !== '..'
		&& !posix.isAbsolute(filename)
		&& !win32.isAbsolute(filename)
		&& posix.basename(filename) === filename
		&& win32.basename(filename) === filename
}

export const ResourceBasenameSchema = z.string().refine(isResourceBasename, {
	message: 'Resource filename must be a basename',
})
