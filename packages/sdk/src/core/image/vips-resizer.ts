import { join } from 'node:path'
import type { FileSystem } from '~/platform/fs.js'
import type { ProcessRunner } from '~/platform/process.js'
import type { ImageResizeOptions, ImageResizer, ImageResizeResult } from './types.js'

export interface VipsImageResizerOptions {
	fs: FileSystem
	process: ProcessRunner
	tmpDir: string
	maxDimension?: number
}

export class VipsImageResizer implements ImageResizer {
	private readonly fs: FileSystem
	private readonly process: ProcessRunner
	private readonly tmpDir: string
	private readonly maxDimension: number

	constructor(options: VipsImageResizerOptions) {
		this.fs = options.fs
		this.process = options.process
		this.tmpDir = options.tmpDir
		this.maxDimension = options.maxDimension ?? 8000
	}

	async resize(filePath: string, mimeType: string, options?: ImageResizeOptions): Promise<ImageResizeResult> {
		const effectiveMaxDimension = options?.maxDimension ?? this.maxDimension
		const signal = options?.signal
		let ownedTempFile: string | undefined
		try {
			signal?.throwIfAborted()
			// Step 1: Dimension resize if needed
			const result = await this.dimensionResize(filePath, mimeType, effectiveMaxDimension, signal)
			ownedTempFile = result.tempFile
			signal?.throwIfAborted()

			// Step 2: If no size constraint, done
			if (!options?.maxFileSizeBytes) {
				signal?.throwIfAborted()
				return result
			}

			// Step 3: Check if result fits
			const fileSize = (await this.fs.stat(result.path)).size
			signal?.throwIfAborted()
			if (fileSize <= options.maxFileSizeBytes) {
				signal?.throwIfAborted()
				return result
			}

			// Step 4: Compress to fit — clean up dimension resize temp first
			if (result.tempFile) {
				await this.fs.unlink(result.tempFile).catch(() => {})
				ownedTempFile = undefined
			}

			signal?.throwIfAborted()
			const compressed = await this.compressToFit(filePath, options.maxFileSizeBytes, effectiveMaxDimension, signal)
			ownedTempFile = compressed.tempFile
			signal?.throwIfAborted()
			return compressed
		} catch (e) {
			if (ownedTempFile) {
				await this.fs.unlink(ownedTempFile).catch(() => {})
			}
			if (signal?.aborted) signal.throwIfAborted()
			console.warn('[image-resize] failed, using original image:', e instanceof Error ? e.message : e)
			return { path: filePath, mimeType }
		}
	}

	private async getImageDimensions(
		filePath: string,
		signal?: AbortSignal,
	): Promise<{ width: number; height: number } | null> {
		const { stdout } = await this.process.execFile('vipsheader', ['-f', 'width', '-f', 'height', filePath], {
			timeout: 30_000,
			signal,
		})
		signal?.throwIfAborted()
		const lines = stdout.trim().split('\n')
		if (lines.length < 2) return null
		const width = parseInt(lines[0], 10)
		const height = parseInt(lines[1], 10)
		if (!Number.isFinite(width) || !Number.isFinite(height)) return null
		return { width, height }
	}

	private async dimensionResize(
		filePath: string,
		mimeType: string,
		maxDimension: number,
		signal?: AbortSignal,
	): Promise<ImageResizeResult> {
		const dims = await this.getImageDimensions(filePath, signal)
		signal?.throwIfAborted()
		const needsResize = dims !== null && (dims.width > maxDimension || dims.height > maxDimension)

		// JPEGs within dimension limits pass through unchanged
		if (mimeType === 'image/jpeg' && !needsResize) {
			signal?.throwIfAborted()
			return { path: filePath, mimeType }
		}

		// Always convert to JPEG (PNG→JPEG saves significant size for LLM context)
		const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
		const outputPath = join(this.tmpDir, `roj-resize-${id}.jpg`)

		try {
			await this.process.execFile(
				'vipsthumbnail',
				[filePath, '--size', `${maxDimension}x${maxDimension}`, '-o', outputPath],
				{ timeout: 30_000, signal },
			)
			signal?.throwIfAborted()
		} catch (error) {
			await this.fs.unlink(outputPath).catch(() => {})
			throw error
		}
		signal?.throwIfAborted()
		return { path: outputPath, mimeType: 'image/jpeg', tempFile: outputPath }
	}

	private async compressToFit(
		filePath: string,
		maxFileSizeBytes: number,
		maxDimension: number,
		signal?: AbortSignal,
	): Promise<ImageResizeResult> {
		const halfDim = Math.floor(maxDimension / 2)
		const attempts = [
			{ dimension: maxDimension, quality: 85 },
			{ dimension: maxDimension, quality: 70 },
			{ dimension: maxDimension, quality: 50 },
			{ dimension: maxDimension, quality: 30 },
			{ dimension: halfDim, quality: 70 },
			{ dimension: halfDim, quality: 50 },
			{ dimension: halfDim, quality: 30 },
		]

		let lastResult: ImageResizeResult | undefined

		try {
			for (const { dimension, quality } of attempts) {
				signal?.throwIfAborted()
				const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
				const outputPath = join(this.tmpDir, `roj-compress-${id}.jpg`)

				try {
					await this.process.execFile(
						'vipsthumbnail',
						[filePath, '--size', `${dimension}x${dimension}`, '-o', `${outputPath}[Q=${quality}]`],
						{ timeout: 30_000, signal },
					)
					signal?.throwIfAborted()

					const outputSize = (await this.fs.stat(outputPath)).size
					signal?.throwIfAborted()
					if (lastResult?.tempFile) {
						await this.fs.unlink(lastResult.tempFile).catch(() => {})
					}
					signal?.throwIfAborted()

					lastResult = {
						path: outputPath,
						mimeType: 'image/jpeg',
						tempFile: outputPath,
					}
					if (outputSize <= maxFileSizeBytes) {
						signal?.throwIfAborted()
						return lastResult
					}
				} catch (error) {
					await this.fs.unlink(outputPath).catch(() => {})
					throw error
				}
			}

			// Return best effort (most compressed) — caller decides what to do
			if (!lastResult) throw new Error('Image compression produced no result')
			signal?.throwIfAborted()
			return lastResult
		} catch (error) {
			if (lastResult?.tempFile) {
				await this.fs.unlink(lastResult.tempFile).catch(() => {})
			}
			throw error
		}
	}
}
