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
		try {
			// Step 1: Dimension resize if needed
			const result = await this.dimensionResize(filePath, mimeType, effectiveMaxDimension)

			// Step 2: If no size constraint, done
			if (!options?.maxFileSizeBytes) return result

			// Step 3: Check if result fits
			const fileSize = (await this.fs.stat(result.path)).size
			if (fileSize <= options.maxFileSizeBytes) return result

			// Step 4: Compress to fit — clean up dimension resize temp first
			if (result.tempFile) {
				await this.fs.unlink(result.tempFile).catch(() => {})
			}

			return await this.compressToFit(filePath, options.maxFileSizeBytes, effectiveMaxDimension)
		} catch (e) {
			console.warn('[image-resize] failed, using original image:', e instanceof Error ? e.message : e)
			return { path: filePath, mimeType }
		}
	}

	private async getImageDimensions(filePath: string): Promise<{ width: number; height: number } | null> {
		const { stdout } = await this.process.execFile('vipsheader', ['-f', 'width', '-f', 'height', filePath], { timeout: 30_000 })
		const lines = stdout.trim().split('\n')
		if (lines.length < 2) return null
		const width = parseInt(lines[0], 10)
		const height = parseInt(lines[1], 10)
		if (!Number.isFinite(width) || !Number.isFinite(height)) return null
		return { width, height }
	}

	private async dimensionResize(filePath: string, mimeType: string, maxDimension: number): Promise<ImageResizeResult> {
		const dims = await this.getImageDimensions(filePath)
		const needsResize = dims !== null && (dims.width > maxDimension || dims.height > maxDimension)

		// JPEGs within dimension limits pass through unchanged
		if (mimeType === 'image/jpeg' && !needsResize) {
			return { path: filePath, mimeType }
		}

		// Always convert to JPEG (PNG→JPEG saves significant size for LLM context)
		const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
		const outputPath = join(this.tmpDir, `roj-resize-${id}.jpg`)

		await this.process.execFile('vipsthumbnail', [
			filePath,
			'--size',
			`${maxDimension}x${maxDimension}`,
			'-o',
			outputPath,
		], { timeout: 30_000 })
		return { path: outputPath, mimeType: 'image/jpeg', tempFile: outputPath }
	}

	private async compressToFit(filePath: string, maxFileSizeBytes: number, maxDimension: number): Promise<ImageResizeResult> {
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

		for (const { dimension, quality } of attempts) {
			const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
			const outputPath = join(this.tmpDir, `roj-compress-${id}.jpg`)

			await this.process.execFile('vipsthumbnail', [
				filePath,
				'--size',
				`${dimension}x${dimension}`,
				'-o',
				`${outputPath}[Q=${quality}]`,
			], { timeout: 30_000 })

			// Clean up previous attempt
			if (lastResult?.tempFile) {
				await this.fs.unlink(lastResult.tempFile).catch(() => {})
			}

			lastResult = { path: outputPath, mimeType: 'image/jpeg', tempFile: outputPath }

			if ((await this.fs.stat(outputPath)).size <= maxFileSizeBytes) {
				return lastResult
			}
		}

		// Return best effort (most compressed) — caller decides what to do
		return lastResult!
	}
}
