/**
 * Upload sources — the bytes of an upload as a preprocessor reads them.
 *
 * A preprocessor gets a source rather than a path, so a host that keeps upload
 * bytes outside the session filesystem (a blob store) can hand them over without
 * first copying them in. Process-based preprocessors still need a local file and
 * read it from `localPath`.
 */

import { Err, Ok, type Result } from '~/lib/utils/result.js'
import type { FileSystem, ReadableFileHandle } from '~/platform/fs.js'

const STREAM_CHUNK_BYTES = 64 * 1024

export interface UploadSource {
	readonly size: number
	/** Hex SHA-256 when the host already verified it. */
	readonly sha256?: string
	/** Host path of the bytes when they are a local file; process-based preprocessors need it. */
	readonly localPath?: string
	stream(): ReadableStream<Uint8Array>
	bytes(): Promise<Uint8Array>
	range(offset: number, length: number): Promise<Uint8Array>
}

/** The upload a blob store call is made for. */
export interface UploadBlobContext {
	readonly sessionId: string
	readonly uploadId: string
}

/** Where a host keeps upload bytes it stored itself (registerStored). */
export interface UploadBlobStore {
	/**
	 * The bytes behind `blobRef`. The ref is untrusted — it comes from whoever called registerStored —
	 * so the store must verify it belongs to `ctx.sessionId` before returning anything.
	 */
	open(blobRef: string, ctx: UploadBlobContext): Promise<Result<UploadSource, Error>>
	/**
	 * Called once after an upload's deletion completed, with the blobs the session's event log ties to it:
	 * the stored original and the artifacts' full-fidelity copies. The store must verify each ref belongs to
	 * `ctx.sessionId`. Blobs written by runs that never reached `ready` are never listed here; the host sweeps
	 * them by its own per-upload prefix, which `ctx.uploadId` names.
	 */
	release?(blobRefs: readonly string[], ctx: UploadBlobContext): Promise<void>
}

/** Wraps a file on the host filesystem; sets `localPath`. */
export async function fileUploadSource(fs: FileSystem, path: string): Promise<Result<UploadSource, Error>> {
	let size: number
	try {
		size = (await fs.stat(path)).size
	} catch (error) {
		// The message can reach a client, so it names the file rather than the host path.
		return Err(new Error(`Upload file not found: ${path.split('/').pop()}`, { cause: error }))
	}
	return Ok({
		size,
		localPath: path,
		stream: () => streamFile(fs, path),
		bytes: () => fs.readFile(path),
		range: (offset, length) => readRange(fs, path, offset, length),
	})
}

async function readRange(fs: FileSystem, path: string, offset: number, length: number): Promise<Uint8Array> {
	if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
		throw new RangeError(`Invalid range: offset ${offset}, length ${length}`)
	}
	const handle = await fs.open(path, 'r')
	try {
		const buffer = Buffer.alloc(length)
		let filled = 0
		while (filled < length) {
			const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled)
			if (bytesRead === 0) break
			filled += bytesRead
		}
		return buffer.subarray(0, filled)
	} finally {
		await handle.close()
	}
}

function streamFile(fs: FileSystem, path: string): ReadableStream<Uint8Array> {
	let handle: ReadableFileHandle | undefined
	let position = 0
	const close = async () => {
		const open = handle
		handle = undefined
		await open?.close()
	}
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				handle ??= await fs.open(path, 'r')
				const buffer = Buffer.alloc(STREAM_CHUNK_BYTES)
				const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
				if (bytesRead === 0) {
					await close()
					controller.close()
					return
				}
				position += bytesRead
				controller.enqueue(buffer.subarray(0, bytesRead))
			} catch (error) {
				await close()
				throw error
			}
		},
		cancel: close,
	})
}
