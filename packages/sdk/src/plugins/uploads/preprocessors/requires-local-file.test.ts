import { describe, expect, it } from 'bun:test'
import { SessionFileStore } from '~/core/file-store/file-store.js'
import type { ProcessRunner } from '~/platform/process.js'
import { silentLogger } from '../../../lib/logger/logger.js'
import { createNodePlatform } from '../../../testing/node-platform.js'
import { type Preprocessor, PreprocessorRegistry } from '../preprocessor.js'
import type { UploadSource } from '../source.js'
import { MarkitdownPreprocessor } from './markitdown-preprocessor.js'
import { PdfPreprocessor } from './pdf-preprocessor.js'
import { ZipPreprocessor } from './zip-preprocessor.js'

describe('process-based preprocessors without a local file', () => {
	const platform = createNodePlatform()
	const commands: string[] = []
	const process: ProcessRunner = {
		async execFile(command) {
			commands.push(command)
			return { stdout: '', stderr: '' }
		},
		spawn() {
			throw new Error('not used')
		},
	}
	const registry = new PreprocessorRegistry()
	const bytes = new Uint8Array([1, 2, 3, 4])
	const blobOnly: UploadSource = {
		size: bytes.length,
		stream: () => new Blob([bytes]).stream(),
		bytes: async () => bytes,
		range: async (offset, length) => bytes.subarray(offset, offset + length),
	}
	const cases: Array<[string, Preprocessor, string]> = [
		['pdf', new PdfPreprocessor({ registry, logger: silentLogger, fs: platform.fs, process }), 'application/pdf'],
		[
			'markitdown',
			new MarkitdownPreprocessor({ registry, logger: silentLogger, fs: platform.fs, process }),
			'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
		],
		['zip', new ZipPreprocessor({ registry, logger: silentLogger, fs: platform.fs, process }), 'application/zip'],
	]

	it.each(cases)('%s returns Err before running any tool', async (name, preprocessor, mimeType) => {
		const files = new SessionFileStore(`/tmp/roj-requires-local-${crypto.randomUUID()}`, undefined, false, platform.fs, 'session')

		const result = await preprocessor.process(blobOnly, mimeType, {
			files,
			uploadId: 'upload',
			sessionId: 'session',
			filename: 'document',
			attempt: 1,
		})

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.error.message).toBe(`The ${name} preprocessor requires a local file`)
		expect(commands).toEqual([])
		expect(await platform.fs.exists(files.getRoots().session)).toBe(false)
	})
})
