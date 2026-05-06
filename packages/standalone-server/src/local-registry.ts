/**
 * On-disk file + resource registry for the standalone server.
 *
 * Stands in for the platform's Contember-backed file/resource service. State
 * lives in `{dataPath}/.roj-platform-state.json` (JSON manifest) plus
 * `{dataPath}/.roj-platform-state/files/{fileId}` (raw bytes). Operations are
 * append-only at the resource level (revisions accumulate), so re-running
 * `roj-standalone` between sessions preserves uploads and revisions added
 * during a previous run.
 *
 * Files are content-addressable by SHA-256 — re-uploading the same bytes
 * returns the existing fileId with `deduped: true`, mirroring the platform's
 * /files/upload contract used by `@roj-ai/client/platform.files.upload`.
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { LocalResource, Logger } from '@roj-ai/sdk'

interface FileMeta {
	id: string
	filename: string
	mimeType: string
	size: number
	contentHash: string
	createdAt: string
}

interface ResourceRevision {
	id: string
	fileId: string
	label: string | null
	createdAt: string
}

interface ResourceRecord {
	id: string
	slug: string
	name: string | null
	description: string | null
	revisions: ResourceRevision[]
	createdAt: string
}

interface RegistryState {
	files: Record<string, FileMeta>
	resources: Record<string, ResourceRecord>
}

export interface ResourceOutput {
	id: string
	slug: string
	name: string | null
	description: string | null
	latestRevision: {
		id: string
		label: string | null
		file: { id: string; filename: string; mimeType: string; size: number }
		createdAt: string
	} | null
	createdAt: string
}

export interface UploadResult {
	fileId: string
	filename: string
	mimeType: string
	size: number
	deduped: boolean
}

export class LocalRegistry {
	private state: RegistryState = { files: {}, resources: {} }
	private statePath: string
	private filesDir: string

	constructor(
		private readonly dataPath: string,
		private readonly logger: Logger,
	) {
		this.statePath = join(dataPath, '.roj-platform-state.json')
		this.filesDir = join(dataPath, '.roj-platform-state', 'files')
	}

	async init(): Promise<void> {
		await mkdir(this.filesDir, { recursive: true })
		if (existsSync(this.statePath)) {
			try {
				const raw = await readFile(this.statePath, 'utf8')
				this.state = JSON.parse(raw)
			} catch (err) {
				this.logger.warn('Local registry manifest is corrupt, starting fresh', {
					err: err instanceof Error ? err.message : String(err),
				})
				this.state = { files: {}, resources: {} }
			}
		}
	}

	async uploadFile(args: {
		buffer?: Buffer
		filename: string
		mimeType: string
		contentHash?: string
	}): Promise<UploadResult | { error: 'file-required'; contentHash: string }> {
		// Phase 1 — preflight by hash. If we already have the bytes, return the
		// existing fileId without needing the body.
		if (args.contentHash) {
			const existing = Object.values(this.state.files).find(f => f.contentHash === args.contentHash)
			if (existing) {
				return {
					fileId: existing.id,
					filename: existing.filename,
					mimeType: existing.mimeType,
					size: existing.size,
					deduped: true,
				}
			}
			if (!args.buffer) {
				return { error: 'file-required', contentHash: args.contentHash }
			}
		}

		if (!args.buffer) {
			throw new Error('uploadFile requires a buffer when contentHash is unknown')
		}

		const contentHash = args.contentHash ?? sha256Hex(args.buffer)

		// Re-check after computing — the client may not have provided a hash but
		// we still want dedupe.
		const matched = Object.values(this.state.files).find(f => f.contentHash === contentHash)
		if (matched) {
			return {
				fileId: matched.id,
				filename: matched.filename,
				mimeType: matched.mimeType,
				size: matched.size,
				deduped: true,
			}
		}

		const id = randomUUID()
		const meta: FileMeta = {
			id,
			filename: args.filename,
			mimeType: args.mimeType,
			size: args.buffer.length,
			contentHash,
			createdAt: new Date().toISOString(),
		}
		await writeFile(join(this.filesDir, id), args.buffer)
		this.state.files[id] = meta
		await this.persist()
		return { fileId: id, filename: meta.filename, mimeType: meta.mimeType, size: meta.size, deduped: false }
	}

	async readFileById(fileId: string): Promise<{ meta: FileMeta; buffer: Buffer } | null> {
		const meta = this.state.files[fileId]
		if (!meta) return null
		try {
			const buffer = await readFile(join(this.filesDir, fileId))
			return { meta, buffer }
		} catch {
			return null
		}
	}

	async createResource(args: {
		slug: string
		name?: string
		description?: string
		fileId: string
		label?: string
	}): Promise<{ resourceId: string; revisionId: string }> {
		if (!this.state.files[args.fileId]) {
			throw new Error(`File not found: ${args.fileId}`)
		}
		const existing = this.findBySlug(args.slug)
		if (existing) {
			throw new Error(`Resource with slug already exists: ${args.slug}`)
		}
		const resourceId = randomUUID()
		const revisionId = randomUUID()
		const now = new Date().toISOString()
		this.state.resources[resourceId] = {
			id: resourceId,
			slug: args.slug,
			name: args.name ?? null,
			description: args.description ?? null,
			revisions: [{ id: revisionId, fileId: args.fileId, label: args.label ?? null, createdAt: now }],
			createdAt: now,
		}
		await this.persist()
		return { resourceId, revisionId }
	}

	async addRevision(args: {
		resourceId?: string
		resourceSlug?: string
		fileId: string
		label?: string
	}): Promise<{ revisionId: string; noop: boolean }> {
		const record = this.findResource(args)
		if (!record) {
			throw new Error('Resource not found')
		}
		if (!this.state.files[args.fileId]) {
			throw new Error(`File not found: ${args.fileId}`)
		}
		const latest = record.revisions[record.revisions.length - 1]
		const incomingLabel = args.label ?? null
		if (latest && latest.fileId === args.fileId && latest.label === incomingLabel) {
			return { revisionId: latest.id, noop: true }
		}
		const revisionId = randomUUID()
		record.revisions.push({
			id: revisionId,
			fileId: args.fileId,
			label: incomingLabel,
			createdAt: new Date().toISOString(),
		})
		await this.persist()
		return { revisionId, noop: false }
	}

	getResource(args: { resourceId?: string; resourceSlug?: string }): ResourceOutput | null {
		const record = this.findResource(args)
		return record ? toResourceOutput(record, this.state.files) : null
	}

	listResources(): ResourceOutput[] {
		return Object.values(this.state.resources).map(r => toResourceOutput(r, this.state.files))
	}

	async deleteResource(resourceId: string): Promise<{ ok: boolean }> {
		if (!this.state.resources[resourceId]) return { ok: true }
		delete this.state.resources[resourceId]
		await this.persist()
		return { ok: true }
	}

	/**
	 * Idempotent: ensures every config-declared local resource exists in the
	 * registry. Skips slugs that already have a record (so previously uploaded
	 * revisions survive restarts).
	 */
	async bootstrapLocalResources(localResources: LocalResource[]): Promise<void> {
		for (const lr of localResources) {
			if (this.findBySlug(lr.slug)) {
				this.logger.info('Local resource already in registry, skipping bootstrap', { slug: lr.slug })
				continue
			}
			const buffer = await readFile(lr.path)
			const filename = basename(lr.path)
			const mimeType = guessMimeType(filename)
			const upload = await this.uploadFile({ buffer, filename, mimeType })
			if ('error' in upload) {
				throw new Error(`Bootstrap upload failed for ${lr.slug}: ${upload.error}`)
			}
			await this.createResource({
				slug: lr.slug,
				name: lr.name ?? lr.slug,
				fileId: upload.fileId,
			})
			this.logger.info('Bootstrapped local resource', { slug: lr.slug, fileId: upload.fileId, size: upload.size })
		}
	}

	private async persist(): Promise<void> {
		const tmp = `${this.statePath}.tmp`
		await writeFile(tmp, JSON.stringify(this.state, null, 2), 'utf8')
		await rename(tmp, this.statePath)
	}

	private findResource(args: { resourceId?: string; resourceSlug?: string }): ResourceRecord | null {
		if (args.resourceId) return this.state.resources[args.resourceId] ?? null
		if (args.resourceSlug) return this.findBySlug(args.resourceSlug)
		return null
	}

	private findBySlug(slug: string): ResourceRecord | null {
		for (const r of Object.values(this.state.resources)) {
			if (r.slug === slug) return r
		}
		return null
	}
}

function toResourceOutput(record: ResourceRecord, files: Record<string, FileMeta>): ResourceOutput {
	const latest = record.revisions[record.revisions.length - 1]
	const file = latest ? files[latest.fileId] : undefined
	return {
		id: record.id,
		slug: record.slug,
		name: record.name,
		description: record.description,
		latestRevision:
			latest && file
				? {
					id: latest.id,
					label: latest.label,
					file: { id: file.id, filename: file.filename, mimeType: file.mimeType, size: file.size },
					createdAt: latest.createdAt,
				}
				: null,
		createdAt: record.createdAt,
	}
}

function sha256Hex(buf: Buffer): string {
	return createHash('sha256').update(buf).digest('hex')
}

function guessMimeType(filename: string): string {
	switch (extname(filename).toLowerCase()) {
		case '.zip':
			return 'application/zip'
		case '.json':
			return 'application/json'
		default:
			return 'application/octet-stream'
	}
}

// Exported for tests / smoke scripts that want to nuke local state cleanly.
export async function clearLocalRegistry(dataPath: string): Promise<void> {
	const statePath = join(dataPath, '.roj-platform-state.json')
	const filesDir = join(dataPath, '.roj-platform-state')
	if (existsSync(statePath)) await rm(statePath)
	if (existsSync(filesDir)) await rm(filesDir, { recursive: true })
}
