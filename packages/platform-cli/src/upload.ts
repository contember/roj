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

	const filename = bundlePath.split('/').pop()!
	const buf = await file.arrayBuffer()
	const contentHash = await sha256Hex(buf)

	// 1. Preflight: ask server if it already has this content for the org.
	let result = await postBundle({ url: options.url, apiKey: options.apiKey, name: options.name, version: options.version, contentHash })

	// 2. Server reports the bundle bytes are missing — retry with body.
	if (result.status === 409 && result.body?.error === 'bundle-required') {
		result = await postBundle({
			url: options.url,
			apiKey: options.apiKey,
			name: options.name,
			version: options.version,
			contentHash,
			body: { buf, filename, mimeType: file.type || 'application/javascript' },
		})
	}

	if (result.status >= 400 || !result.body?.ok) {
		console.error('Upload failed:', result.body?.error ?? `HTTP ${result.status}`)
		process.exit(1)
	}

	const status = result.body.noop
		? `unchanged (latest revision already at ${shortHash(contentHash)})`
		: result.body.deduped
			? `new revision pointing at existing bundle (${shortHash(contentHash)})`
			: `uploaded new bundle (${shortHash(contentHash)})`

	console.log(`${status}: slug=${result.body.bundleSlug} revisionId=${result.body.revisionId}`)
}

interface PostBundleArgs {
	url: string
	apiKey: string
	name: string
	version?: string
	contentHash: string
	body?: { buf: ArrayBuffer; filename: string; mimeType: string }
}

interface PostBundleResult {
	status: number
	body: {
		ok?: boolean
		error?: string
		bundleSlug?: string
		revisionId?: string
		r2Key?: string
		deduped?: boolean
		noop?: boolean
	} | null
}

async function postBundle(args: PostBundleArgs): Promise<PostBundleResult> {
	const formData = new FormData()
	formData.append('name', args.name)
	formData.append('contentHash', args.contentHash)
	if (args.version) formData.append('version', args.version)
	if (args.body) {
		formData.append('bundle', new Blob([args.body.buf], { type: args.body.mimeType }), args.body.filename)
	}

	const response = await fetch(`${args.url}/api/v1/bundles/upload`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${args.apiKey}` },
		body: formData,
	})

	const body = await response.json().catch(() => null) as PostBundleResult['body']
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

function shortHash(hex: string): string {
	return hex.slice(0, 12)
}
