import { execSync } from 'node:child_process'
import { mkdtempSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

export async function uploadResource(pathOrDir: string, options: {
	url: string
	apiKey: string
	slug: string
	name?: string
	description?: string
	label?: string
}): Promise<void> {
	const resolved = resolve(pathOrDir)
	const stats = statSync(resolved)
	const headers = { Authorization: `Bearer ${options.apiKey}` }

	let filePath: string
	let filename: string
	let mimeType: string
	let tempDir: string | undefined

	if (stats.isDirectory()) {
		// ZIP the directory
		tempDir = mkdtempSync(join(tmpdir(), 'roj-resource-'))
		filename = `${options.slug}.zip`
		filePath = join(tempDir, filename)
		mimeType = 'application/zip'
		console.log(`Zipping directory: ${resolved}`)
		execSync(`zip -r ${JSON.stringify(filePath)} .`, { cwd: resolved, stdio: 'pipe' })
	} else {
		filePath = resolved
		filename = basename(resolved)
		mimeType = guessMimeType(filename)
	}

	try {
		// 1. Hash file content for dedup
		const file = Bun.file(filePath)
		const buf = await file.arrayBuffer()
		const contentHash = await sha256Hex(buf)

		// 2. Preflight upload — if hash already known, server skips R2 put.
		let uploadResult = await postFile({ url: options.url, apiKey: options.apiKey, contentHash, filename, mimeType })
		if (uploadResult.status === 409 && uploadResult.body?.error === 'file-required') {
			uploadResult = await postFile({
				url: options.url,
				apiKey: options.apiKey,
				contentHash,
				filename,
				mimeType,
				body: { buf, filename, mimeType },
			})
		}

		if (uploadResult.status >= 400 || !uploadResult.body?.ok || !uploadResult.body.fileId) {
			console.error('File upload failed:', uploadResult.body?.error ?? `HTTP ${uploadResult.status}`)
			process.exit(1)
		}

		const fileId = uploadResult.body.fileId
		const dedupNote = uploadResult.body.deduped ? ' (deduped, reused existing R2 object)' : ''
		console.log(`File uploaded: ${fileId}${dedupNote}`)

		// 3. Check if resource exists
		const getResponse = await fetch(`${options.url}/api/v1/rpc`, {
			method: 'POST',
			headers: { ...headers, 'Content-Type': 'application/json' },
			body: JSON.stringify({ method: 'resources.get', input: { resourceSlug: options.slug } }),
		})

		const getResult = await getResponse.json() as { ok: boolean; value?: unknown }

		if (getResult.ok) {
			// 3a. Resource exists → add revision
			console.log(`Resource "${options.slug}" exists, adding revision...`)
			const revResponse = await fetch(`${options.url}/api/v1/rpc`, {
				method: 'POST',
				headers: { ...headers, 'Content-Type': 'application/json' },
				body: JSON.stringify({
					method: 'resources.addRevision',
					input: {
						resourceSlug: options.slug,
						fileId,
						label: options.label,
					},
				}),
			})

			const revResult = await revResponse.json() as { ok: boolean; value?: { revisionId: string; noop?: boolean } }
			if (!revResult.ok || !revResult.value) {
				console.error('Failed to add revision:', revResult)
				process.exit(1)
			}
			if (revResult.value.noop) {
				console.log(`Unchanged: latest revision already points at this file (revisionId=${revResult.value.revisionId})`)
			} else {
				console.log(`Revision added: ${revResult.value.revisionId}`)
			}
		} else {
			// 3b. Resource doesn't exist → create
			console.log(`Creating resource "${options.slug}"...`)
			const createResponse = await fetch(`${options.url}/api/v1/rpc`, {
				method: 'POST',
				headers: { ...headers, 'Content-Type': 'application/json' },
				body: JSON.stringify({
					method: 'resources.create',
					input: {
						slug: options.slug,
						name: options.name,
						description: options.description,
						fileId,
						label: options.label,
					},
				}),
			})

			const createResult = await createResponse.json() as { ok: boolean; value?: { resourceId: string; revisionId: string } }
			if (!createResult.ok) {
				console.error('Failed to create resource:', createResult)
				process.exit(1)
			}
			console.log(`Resource created: id=${createResult.value?.resourceId} revision=${createResult.value?.revisionId}`)
		}
	} finally {
		// Clean up temp dir
		if (tempDir) {
			execSync(`rm -rf ${JSON.stringify(tempDir)}`)
		}
	}
}

interface PostFileArgs {
	url: string
	apiKey: string
	contentHash: string
	filename: string
	mimeType: string
	body?: { buf: ArrayBuffer; filename: string; mimeType: string }
}

interface PostFileResult {
	status: number
	body: {
		ok?: boolean
		error?: string
		fileId?: string
		filename?: string
		mimeType?: string
		size?: number
		r2Key?: string
		deduped?: boolean
	} | null
}

async function postFile(args: PostFileArgs): Promise<PostFileResult> {
	const formData = new FormData()
	formData.append('contentHash', args.contentHash)
	formData.append('filename', args.filename)
	formData.append('mimeType', args.mimeType)
	if (args.body) {
		formData.append('file', new Blob([args.body.buf], { type: args.body.mimeType }), args.body.filename)
	}

	const response = await fetch(`${args.url}/api/v1/files/upload`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${args.apiKey}` },
		body: formData,
	})

	const body = await response.json().catch(() => null) as PostFileResult['body']
	return { status: response.status, body }
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', buf)
	const bytes = new Uint8Array(digest)
	let hex = ''
	for (let i = 0; i < bytes.length; i++) {
		hex += bytes[i].toString(16).padStart(2, '0')
	}
	return hex
}

function guessMimeType(filename: string): string {
	const ext = filename.split('.').pop()?.toLowerCase()
	switch (ext) {
		case 'zip': return 'application/zip'
		case 'json': return 'application/json'
		case 'js': case 'mjs': return 'application/javascript'
		case 'html': case 'htm': return 'text/html'
		case 'css': return 'text/css'
		case 'png': return 'image/png'
		case 'jpg': case 'jpeg': return 'image/jpeg'
		case 'pdf': return 'application/pdf'
		default: return 'application/octet-stream'
	}
}
