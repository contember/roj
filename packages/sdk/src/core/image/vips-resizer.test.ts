import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import * as childProcess from 'node:child_process'

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void
let execFileImpl: (cmd: string, args: string[], opts: unknown, cb: ExecFileCallback) => void = () => {}

mock.module('node:child_process', () => ({
	...childProcess,
	execFile: (cmd: string, args: string[], opts: unknown, cb: ExecFileCallback) => execFileImpl(cmd, args, opts, cb),
}))

const { VipsImageResizer } = await import('./vips-resizer.js')
const { createNodePlatform } = await import('~/testing/node-platform.js')

// Test-scoped helper — routes through createNodePlatform so the module-level
// node:child_process mock still intercepts execFile calls made by ProcessRunner.
function createResizer(maxDimension?: number): InstanceType<typeof VipsImageResizer> {
	const platform = createNodePlatform()
	return new VipsImageResizer({
		fs: platform.fs,
		process: platform.process,
		tmpDir: platform.tmpDir,
		maxDimension,
	})
}

const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

afterEach(() => {
	warnSpy.mockClear()
	execFileImpl = () => {}
})

describe('VipsImageResizer', () => {
	const testJpegPath = '/tmp/test-image.jpg'

	it('returns original path and mimeType when jpeg is within limits', async () => {
		execFileImpl = (cmd, _args, _opts, cb) => {
			if (cmd === 'vipsheader') cb(null, '4000\n3000\n', '')
		}

		const resizer = createResizer()
		const result = await resizer.resize(testJpegPath, 'image/jpeg')

		expect(result).toEqual({ path: testJpegPath, mimeType: 'image/jpeg' })
	})

	it('returns original path when jpeg is exactly at dimension limit', async () => {
		execFileImpl = (cmd, _args, _opts, cb) => {
			if (cmd === 'vipsheader') cb(null, '8000\n8000\n', '')
		}

		const resizer = createResizer()
		const result = await resizer.resize(testJpegPath, 'image/jpeg')

		expect(result).toEqual({ path: testJpegPath, mimeType: 'image/jpeg' })
	})

	it('converts png to jpeg even when within dimension limits', async () => {
		execFileImpl = (cmd, _args, _opts, cb) => {
			if (cmd === 'vipsheader') cb(null, '4000\n3000\n', '')
			else if (cmd === 'vipsthumbnail') cb(null, '', '')
		}

		const resizer = createResizer()
		const result = await resizer.resize('/tmp/test.png', 'image/png')

		expect(result.path).toEndWith('.jpg')
		expect(result.mimeType).toBe('image/jpeg')
		expect(result.tempFile).toBeDefined()
	})

	it('calls vipsthumbnail and returns temp path when width exceeds limit', async () => {
		let thumbnailArgs: string[] = []
		execFileImpl = (cmd, args, _opts, cb) => {
			if (cmd === 'vipsheader') cb(null, '10000\n5000\n', '')
			else if (cmd === 'vipsthumbnail') {
				thumbnailArgs = args
				cb(null, '', '')
			}
		}

		const resizer = createResizer()
		const result = await resizer.resize('/tmp/test.png', 'image/png')

		expect(result.path).not.toBe('/tmp/test.png')
		expect(result.tempFile).toBe(result.path)
		expect(result.path).toContain('roj-resize-')
		expect(result.path).toEndWith('.jpg')
		expect(result.mimeType).toBe('image/jpeg')
		expect(thumbnailArgs).toContain('--size')
		expect(thumbnailArgs).toContain('8000x8000')
		expect(thumbnailArgs).toContain('/tmp/test.png')
	})

	it('calls vipsthumbnail when height exceeds limit', async () => {
		execFileImpl = (cmd, _args, _opts, cb) => {
			if (cmd === 'vipsheader') cb(null, '4000\n12000\n', '')
			else if (cmd === 'vipsthumbnail') cb(null, '', '')
		}

		const resizer = createResizer()
		const result = await resizer.resize(testJpegPath, 'image/jpeg')

		expect(result.tempFile).toBeDefined()
		expect(result.path).toEndWith('.jpg')
		expect(result.mimeType).toBe('image/jpeg')
	})

	it('converts webp to jpeg on resize', async () => {
		execFileImpl = (cmd, _args, _opts, cb) => {
			if (cmd === 'vipsheader') cb(null, '9000\n9000\n', '')
			else if (cmd === 'vipsthumbnail') cb(null, '', '')
		}

		const resizer = createResizer()
		const result = await resizer.resize('/tmp/test.webp', 'image/webp')

		expect(result.path).toEndWith('.jpg')
		expect(result.mimeType).toBe('image/jpeg')
	})

	it('converts gif to jpeg on resize', async () => {
		execFileImpl = (cmd, _args, _opts, cb) => {
			if (cmd === 'vipsheader') cb(null, '9000\n9000\n', '')
			else if (cmd === 'vipsthumbnail') cb(null, '', '')
		}

		const resizer = createResizer()
		const result = await resizer.resize('/tmp/test.gif', 'image/gif')

		expect(result.path).toEndWith('.jpg')
		expect(result.mimeType).toBe('image/jpeg')
	})

	it('converts png to jpeg on resize', async () => {
		execFileImpl = (cmd, _args, _opts, cb) => {
			if (cmd === 'vipsheader') cb(null, '9000\n9000\n', '')
			else if (cmd === 'vipsthumbnail') cb(null, '', '')
		}

		const resizer = createResizer()
		const result = await resizer.resize('/tmp/test.png', 'image/png')

		expect(result.path).toEndWith('.jpg')
		expect(result.mimeType).toBe('image/jpeg')
	})

	it('returns original path when vipsheader fails (graceful degradation)', async () => {
		execFileImpl = (_cmd, _args, _opts, cb) => {
			cb(new Error('vipsheader: command not found'), '', '')
		}

		const resizer = createResizer()
		const result = await resizer.resize(testJpegPath, 'image/png')

		expect(result).toEqual({ path: testJpegPath, mimeType: 'image/png' })
		expect(warnSpy).toHaveBeenCalled()
	})

	it('returns original path when vipsthumbnail fails (graceful degradation)', async () => {
		execFileImpl = (cmd, _args, _opts, cb) => {
			if (cmd === 'vipsheader') cb(null, '10000\n10000\n', '')
			else if (cmd === 'vipsthumbnail') cb(new Error('vipsthumbnail: command not found'), '', '')
		}

		const resizer = createResizer()
		const result = await resizer.resize(testJpegPath, 'image/png')

		expect(result).toEqual({ path: testJpegPath, mimeType: 'image/png' })
		expect(warnSpy).toHaveBeenCalled()
	})

	it('returns original path when vipsheader returns unparseable output for jpeg', async () => {
		execFileImpl = (cmd, _args, _opts, cb) => {
			if (cmd === 'vipsheader') cb(null, 'not-a-number\n', '')
		}

		const resizer = createResizer()
		const result = await resizer.resize(testJpegPath, 'image/jpeg')

		expect(result).toEqual({ path: testJpegPath, mimeType: 'image/jpeg' })
	})

	it('uses custom maxDimension', async () => {
		let thumbnailArgs: string[] = []
		execFileImpl = (cmd, args, _opts, cb) => {
			if (cmd === 'vipsheader') cb(null, '5000\n5000\n', '')
			else if (cmd === 'vipsthumbnail') {
				thumbnailArgs = args
				cb(null, '', '')
			}
		}

		const resizer = createResizer(4000)
		const result = await resizer.resize(testJpegPath, 'image/jpeg')

		expect(result.tempFile).toBeDefined()
		expect(thumbnailArgs).toContain('4000x4000')
	})

	describe('compression (maxFileSizeBytes)', () => {
		it('skips compression when file fits within limit', async () => {
			const testPath = '/tmp/test-small.jpg'
			// Write a small file for size check
			await Bun.write(testPath, Buffer.alloc(100))

			execFileImpl = (cmd, _args, _opts, cb) => {
				if (cmd === 'vipsheader') cb(null, '4000\n3000\n', '')
			}

			const resizer = createResizer()
			const result = await resizer.resize(testPath, 'image/jpeg', { maxFileSizeBytes: 1000 })

			expect(result).toEqual({ path: testPath, mimeType: 'image/jpeg' })

			await import('node:fs/promises').then(fs => fs.unlink(testPath).catch(() => {}))
		})

		it('tries compression with quality steps when file exceeds limit', async () => {
			const testPath = '/tmp/test-large-compress.jpg'
			await Bun.write(testPath, Buffer.alloc(2000))

			const thumbnailCalls: Array<{ args: string[] }> = []

			execFileImpl = (cmd, args, _opts, cb) => {
				if (cmd === 'vipsheader') {
					cb(null, '4000\n3000\n', '')
				} else if (cmd === 'vipsthumbnail') {
					thumbnailCalls.push({ args })
					// Write a small file so it fits on first compression attempt
					const outputArg = args[args.indexOf('-o') + 1]
					const outputPath = outputArg.replace(/\[.*\]$/, '')
					Bun.write(outputPath, Buffer.alloc(50)).then(() => cb(null, '', ''))
				}
			}

			const resizer = createResizer()
			const result = await resizer.resize(testPath, 'image/jpeg', { maxFileSizeBytes: 100 })

			expect(result.mimeType).toBe('image/jpeg')
			expect(result.tempFile).toBeDefined()
			expect(thumbnailCalls.length).toBe(1) // First quality step should succeed
			// Check it used quality parameter
			const outputArg = thumbnailCalls[0].args[thumbnailCalls[0].args.indexOf('-o') + 1]
			expect(outputArg).toContain('[Q=85]')

			if (result.tempFile) {
				await import('node:fs/promises').then(fs => fs.unlink(result.tempFile!).catch(() => {}))
			}
			await import('node:fs/promises').then(fs => fs.unlink(testPath).catch(() => {}))
		})

		it('tries progressively lower quality until file fits', async () => {
			const testPath = '/tmp/test-progressive.jpg'
			await Bun.write(testPath, Buffer.alloc(2000))

			let compressionAttempts = 0

			execFileImpl = (cmd, args, _opts, cb) => {
				if (cmd === 'vipsheader') {
					cb(null, '4000\n3000\n', '')
				} else if (cmd === 'vipsthumbnail') {
					compressionAttempts++
					const outputArg = args[args.indexOf('-o') + 1]
					const outputPath = outputArg.replace(/\[.*\]$/, '')
					// First two attempts produce large files, third fits
					const size = compressionAttempts <= 2 ? 2000 : 50
					Bun.write(outputPath, Buffer.alloc(size)).then(() => cb(null, '', ''))
				}
			}

			const resizer = createResizer()
			const result = await resizer.resize(testPath, 'image/jpeg', { maxFileSizeBytes: 100 })

			expect(compressionAttempts).toBe(3) // Q=85, Q=70 failed, Q=50 succeeded
			expect(result.mimeType).toBe('image/jpeg')

			if (result.tempFile) {
				await import('node:fs/promises').then(fs => fs.unlink(result.tempFile!).catch(() => {}))
			}
			await import('node:fs/promises').then(fs => fs.unlink(testPath).catch(() => {}))
		})

		it('halves dimensions when quality reduction is insufficient', async () => {
			const testPath = '/tmp/test-half-dim.jpg'
			await Bun.write(testPath, Buffer.alloc(2000))

			const dimensionArgs: string[] = []
			let compressionAttempts = 0

			execFileImpl = (cmd, args, _opts, cb) => {
				if (cmd === 'vipsheader') {
					cb(null, '4000\n3000\n', '')
				} else if (cmd === 'vipsthumbnail') {
					compressionAttempts++
					dimensionArgs.push(args[args.indexOf('--size') + 1])
					const outputArg = args[args.indexOf('-o') + 1]
					const outputPath = outputArg.replace(/\[.*\]$/, '')
					// Only the last attempt (halved dimensions, Q=30) fits
					const size = compressionAttempts < 7 ? 2000 : 50
					Bun.write(outputPath, Buffer.alloc(size)).then(() => cb(null, '', ''))
				}
			}

			const resizer = createResizer()
			const result = await resizer.resize(testPath, 'image/jpeg', { maxFileSizeBytes: 100 })

			// 4 full-dim attempts + 3 half-dim attempts
			expect(compressionAttempts).toBe(7)
			// First 4 at full dimension, last 3 at half
			expect(dimensionArgs[0]).toBe('8000x8000')
			expect(dimensionArgs[4]).toBe('4000x4000')
			expect(result.mimeType).toBe('image/jpeg')

			if (result.tempFile) {
				await import('node:fs/promises').then(fs => fs.unlink(result.tempFile!).catch(() => {}))
			}
			await import('node:fs/promises').then(fs => fs.unlink(testPath).catch(() => {}))
		})

		it('returns best effort when nothing fits', async () => {
			const testPath = '/tmp/test-nothing-fits.jpg'
			await Bun.write(testPath, Buffer.alloc(2000))

			execFileImpl = (cmd, args, _opts, cb) => {
				if (cmd === 'vipsheader') {
					cb(null, '4000\n3000\n', '')
				} else if (cmd === 'vipsthumbnail') {
					const outputArg = args[args.indexOf('-o') + 1]
					const outputPath = outputArg.replace(/\[.*\]$/, '')
					// Always too large
					Bun.write(outputPath, Buffer.alloc(2000)).then(() => cb(null, '', ''))
				}
			}

			const resizer = createResizer()
			const result = await resizer.resize(testPath, 'image/jpeg', { maxFileSizeBytes: 100 })

			// Returns the last attempt even though it doesn't fit
			expect(result.mimeType).toBe('image/jpeg')
			expect(result.tempFile).toBeDefined()

			if (result.tempFile) {
				await import('node:fs/promises').then(fs => fs.unlink(result.tempFile!).catch(() => {}))
			}
			await import('node:fs/promises').then(fs => fs.unlink(testPath).catch(() => {}))
		})

		it('always outputs jpeg when compressing', async () => {
			const testPath = '/tmp/test-png-compress.png'
			await Bun.write(testPath, Buffer.alloc(2000))

			execFileImpl = (cmd, args, _opts, cb) => {
				if (cmd === 'vipsheader') {
					cb(null, '4000\n3000\n', '')
				} else if (cmd === 'vipsthumbnail') {
					const outputArg = args[args.indexOf('-o') + 1]
					const outputPath = outputArg.replace(/\[.*\]$/, '')
					Bun.write(outputPath, Buffer.alloc(50)).then(() => cb(null, '', ''))
				}
			}

			const resizer = createResizer()
			const result = await resizer.resize(testPath, 'image/png', { maxFileSizeBytes: 100 })

			// Even though input was PNG, compression outputs JPEG
			expect(result.mimeType).toBe('image/jpeg')
			expect(result.path).toContain('.jpg')

			if (result.tempFile) {
				await import('node:fs/promises').then(fs => fs.unlink(result.tempFile!).catch(() => {}))
			}
			await import('node:fs/promises').then(fs => fs.unlink(testPath).catch(() => {}))
		})
	})
})
