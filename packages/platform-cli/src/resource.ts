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
		// 1. Upload file
		console.log(`Uploading file: ${filename}`)
		const file = Bun.file(filePath)
		const formData = new FormData()
		formData.append('file', file, filename)

		const uploadResponse = await fetch(`${options.url}/api/v1/files/upload`, {
			method: 'POST',
			headers,
			body: formData,
		})

		if (!uploadResponse.ok) {
			const error = await uploadResponse.json().catch(() => ({ error: uploadResponse.statusText }))
			console.error('File upload failed:', (error as { error?: string }).error ?? uploadResponse.statusText)
			process.exit(1)
		}

		const uploadResult = await uploadResponse.json() as { fileId: string }
		console.log(`File uploaded: ${uploadResult.fileId}`)

		// 2. Check if resource exists
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
						fileId: uploadResult.fileId,
						label: options.label,
					},
				}),
			})

			const revResult = await revResponse.json() as { ok: boolean; value?: { revisionId: string } }
			if (!revResult.ok) {
				console.error('Failed to add revision:', revResult)
				process.exit(1)
			}
			console.log(`Revision added: ${revResult.value?.revisionId}`)
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
						fileId: uploadResult.fileId,
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
