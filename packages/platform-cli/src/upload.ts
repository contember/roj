export async function upload(bundlePath: string, options: {
	url: string
	apiKey: string
	name: string
	version?: string
}): Promise<void> {
	const file = Bun.file(bundlePath)
	if (!(await file.exists())) {
		console.error(`Bundle not found: ${bundlePath}`)
		process.exit(1)
	}

	const formData = new FormData()
	formData.append('bundle', file, bundlePath.split('/').pop()!)
	formData.append('name', options.name)
	if (options.version) {
		formData.append('version', options.version)
	}

	const response = await fetch(`${options.url}/api/v1/bundles/upload`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${options.apiKey}` },
		body: formData,
	})

	if (!response.ok) {
		const error = await response.json().catch(() => ({ error: response.statusText }))
		console.error('Upload failed:', (error as { error?: string }).error ?? response.statusText)
		process.exit(1)
	}

	const result = await response.json() as { ok: boolean; bundleSlug?: string; revisionId?: string; r2Key?: string }
	console.log(`Uploaded: slug=${result.bundleSlug} revisionId=${result.revisionId}`)
}
