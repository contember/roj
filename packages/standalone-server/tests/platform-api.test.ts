import { afterEach, describe, expect, it } from 'bun:test'
import type { Logger } from '@roj-ai/sdk'
import { ModelId, SessionId } from '@roj-ai/sdk'
import type { Preset } from '@roj-ai/sdk'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { createInstance } from '../src/instance.js'
import { LocalRegistry } from '../src/local-registry.js'
import { createPlatformApi } from '../src/platform-api.js'

const RpcResultSchema = z.union([
	z.object({ ok: z.literal(true), value: z.unknown() }),
	z.object({
		ok: z.literal(false),
		error: z.object({ type: z.string(), message: z.string() }),
	}),
])

const CreateInstanceValueSchema = z.object({
	instanceId: z.string(),
	status: z.enum(['created', 'initializing', 'ready']),
	sessionId: z.string().optional(),
})

const InjectionInputSchema = z.object({
	filename: z.string(),
	mimeType: z.string(),
	fileBuffer: z.custom<Buffer>(),
})

const SessionCreateInputSchema = z.object({ sessionId: z.string() })
const PromptInputSchema = z.object({ content: z.string() })

const cleanupPaths: string[] = []
const cleanupFailureCases: Array<{
	stage: 'getSession' | 'close' | 'worktree'
	expectedLog: string
}> = [
	{ stage: 'getSession', expectedLog: 'Failed to load session for rollback' },
	{ stage: 'close', expectedLog: 'Failed to close session during rollback' },
	{ stage: 'worktree', expectedLog: 'Failed to remove session worktree during rollback' },
]

afterEach(async () => {
	await Promise.all(cleanupPaths.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function createFixture(options: { presets?: Preset[] } = {}) {
	const path = join(tmpdir(), `roj-standalone-platform-${crypto.randomUUID()}`)
	cleanupPaths.push(path)
	const calls: string[] = []
	const warnings: Array<{ message: string; context?: Record<string, unknown> }> = []
	const errors: string[] = []
	const activeSessions = new Set<string>()
	const worktrees = new Set<string>()
	let failNextInjection = false
	let malformedSessionList = false
	let cleanupFailure: 'getSession' | 'close' | 'worktree' | undefined

	const logger: Logger = {
		debug() {},
		info() {},
		warn(message, context) {
			warnings.push({ message, context })
		},
		error(message) {
			errors.push(message)
		},
		child() {
			return logger
		},
		level: 'debug',
	}

	const registry = new LocalRegistry(path, logger)
	await registry.init()

	const sessionManager = {
		async callManagerMethod(method: string, input: unknown) {
			if (method === 'sessions.create') {
				const { sessionId } = SessionCreateInputSchema.parse(input)
				calls.push(`session:create:${sessionId}`)
				activeSessions.add(sessionId)
				return { ok: true, value: { sessionId } }
			}
			if (method === 'sessions.list') {
				return malformedSessionList
					? { ok: true, value: { sessions: [{ malformed: true }], total: 1 } }
					: { ok: true, value: { sessions: [], total: 0 } }
			}
			return {
				ok: false,
				error: { type: 'validation_error', message: `Unknown method: ${method}`, httpStatus: 400 },
			}
		},
		async callPluginMethod(_sessionId: SessionId, method: string, input: unknown) {
			if (method === 'resources.inject') {
				const parsed = InjectionInputSchema.parse(input)
				calls.push(`inject:${parsed.filename}`)
				if (failNextInjection) {
					failNextInjection = false
					return {
						ok: false,
						error: { type: 'injection_failed', message: 'deterministic injection failure', httpStatus: 400 },
					}
				}
				return { ok: true, value: { resourceId: 'injected', paths: [parsed.filename] } }
			}
			if (method === 'user-chat.sendMessage') {
				const parsed = PromptInputSchema.parse(input)
				calls.push(`prompt:${parsed.content}`)
				return { ok: true, value: {} }
			}
			return {
				ok: false,
				error: { type: 'validation_error', message: `Unknown method: ${method}`, httpStatus: 400 },
			}
		},
		async withSessionLease(sessionId: SessionId, reason: string, operation) {
			const id = String(sessionId)
			if (cleanupFailure === 'getSession') throw new Error('getSession cleanup failed')
			if (!activeSessions.has(id)) {
				return {
					ok: false,
					error: { type: 'session_not_found', message: `Session not found: ${id}`, httpStatus: 404 },
				}
			}
			calls.push(`session:lease:acquire:${reason}:${id}`)
			try {
				return await operation({
					async close() {
						if (cleanupFailure === 'close') throw new Error('close cleanup failed')
						calls.push(`session:close:${id}`)
						activeSessions.delete(id)
						return { ok: true, value: undefined }
					},
				})
			} finally {
				calls.push(`session:lease:release:${reason}:${id}`)
			}
		},
		async getStats() {
			return {
				sessions: [...activeSessions].map(id => ({ id: SessionId(id), presetId: 'edit', status: 'active' })),
			}
		},
	} satisfies Parameters<typeof createPlatformApi>[0]['sessionManager']

	const gitFs = {
		async addSessionWorktree(_instanceId: string, sessionId: string) {
			calls.push(`worktree:add:${sessionId}`)
			worktrees.add(sessionId)
			return join(path, 'sessions', sessionId)
		},
		async removeSessionWorktree(_instanceId: string, sessionId: string) {
			if (cleanupFailure === 'worktree') throw new Error('worktree cleanup failed')
			calls.push(`worktree:remove:${sessionId}`)
			worktrees.delete(sessionId)
		},
	}

	const app = createPlatformApi({
		instance: createInstance({ id: 'instance-1', presetIds: ['edit'] }),
		sessionManager,
		logger,
		presets: options.presets ?? [],
		registry,
		gitFs,
		tokenSecret: 'test-secret',
		getPublicBaseUrl: () => 'http://127.0.0.1:2486',
	})

	return {
		app,
		registry,
		calls,
		warnings,
		errors,
		activeSessions,
		worktrees,
		failNextInjection() {
			failNextInjection = true
		},
		returnMalformedSessionList() {
			malformedSessionList = true
		},
		failCleanupAt(stage: 'getSession' | 'close' | 'worktree') {
			cleanupFailure = stage
		},
	}
}

function presetWithDefaults(...defaultResourceSlugs: string[]): Preset {
	return {
		id: 'edit',
		name: 'Edit',
		orchestrator: {
			system: 'Test orchestrator',
			model: ModelId('mock'),
			tools: [],
			agents: [],
		},
		agents: [],
		defaultResourceSlugs,
	}
}

async function rpc(app: ReturnType<typeof createPlatformApi>, method: string, input: unknown) {
	const response = await app.request('/rpc', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ method, input }),
	})
	return RpcResultSchema.parse(await response.json())
}

function createInstanceInput(autoCreateSession?: Record<string, unknown>) {
	return {
		templateSlug: 'standalone',
		name: 'Standalone',
		...(autoCreateSession ? { autoCreateSession } : {}),
	}
}

describe('standalone platform RPC', () => {
	it.each(['resourceIds', 'fileIds'])('rejects %s on public sessions.create', async (field) => {
		const fixture = await createFixture()
		const result = await rpc(fixture.app, 'sessions.create', {
			instanceId: 'instance-1',
			presetId: 'edit',
			[field]: ['forbidden'],
		})

		expect(result.ok).toBe(false)
		if (result.ok) throw new Error('Expected sessions.create validation failure')
		expect(result.error.type).toBe('handler_error')
		expect(result.error.message).toContain('Unrecognized key')
		expect(fixture.calls).toEqual([])
	})

	it('injects resourceIds and fileIds once before initialPrompt', async () => {
		const fixture = await createFixture()
		const resourceFile = await fixture.registry.uploadFile({
			buffer: Buffer.from('resource'),
			filename: 'resource.txt',
			mimeType: 'text/plain',
		})
		if ('error' in resourceFile) throw new Error('Expected resource registry file')
		const directFile = await fixture.registry.uploadFile({
			buffer: Buffer.from('direct'),
			filename: 'direct.txt',
			mimeType: 'text/plain',
		})
		if ('error' in directFile) throw new Error('Expected direct registry file')
		const resource = await fixture.registry.createResource({
			slug: 'context',
			name: 'Context',
			fileId: resourceFile.fileId,
		})

		const result = await rpc(fixture.app, 'instances.create', createInstanceInput({
			presetId: 'edit',
			resourceIds: [resource.resourceId, 'context'],
			fileIds: [directFile.fileId, directFile.fileId, resourceFile.fileId],
			initialPrompt: 'Start now',
		}))

		expect(result.ok).toBe(true)
		if (!result.ok) throw new Error(result.error.message)
		const created = CreateInstanceValueSchema.parse(result.value)
		expect(created.sessionId).toBeDefined()
		const sessionId = created.sessionId
		if (!sessionId) throw new Error('Expected auto-created session')
		expect(fixture.calls).toEqual([
			`worktree:add:${sessionId}`,
			`session:create:${sessionId}`,
			'inject:resource.txt',
			'inject:direct.txt',
			'prompt:Start now',
		])
	})

	it('warns and skips missing resource and file IDs', async () => {
		const fixture = await createFixture()
		const result = await rpc(fixture.app, 'instances.create', createInstanceInput({
			presetId: 'edit',
			resourceIds: ['missing-resource'],
			fileIds: ['missing-file'],
			initialPrompt: 'Continue',
		}))

		expect(result.ok).toBe(true)
		expect(fixture.calls.filter(call => call.startsWith('inject:'))).toEqual([])
		expect(fixture.calls.at(-1)).toBe('prompt:Continue')
		expect(fixture.warnings.map(warning => warning.message)).toEqual([
			'Some input resourceIds did not match the local registry; ignoring',
			'Selected fileId did not match the local registry; ignoring',
		])
	})

	it('uses preset defaults when both explicit ID arrays are empty', async () => {
		const fixture = await createFixture({ presets: [presetWithDefaults('default-context')] })
		const uploaded = await fixture.registry.uploadFile({
			buffer: Buffer.from('default'),
			filename: 'default.txt',
			mimeType: 'text/plain',
		})
		if ('error' in uploaded) throw new Error('Expected default registry file')
		await fixture.registry.createResource({ slug: 'default-context', fileId: uploaded.fileId })

		const result = await rpc(fixture.app, 'instances.create', createInstanceInput({
			presetId: 'edit',
			resourceIds: [],
			fileIds: [],
		}))

		expect(result.ok).toBe(true)
		expect(fixture.calls.filter(call => call.startsWith('inject:'))).toEqual(['inject:default.txt'])
	})

	it('does not fall back to preset defaults when an explicit ID is missing', async () => {
		const fixture = await createFixture({ presets: [presetWithDefaults('default-context')] })
		const uploaded = await fixture.registry.uploadFile({
			buffer: Buffer.from('default'),
			filename: 'default.txt',
			mimeType: 'text/plain',
		})
		if ('error' in uploaded) throw new Error('Expected default registry file')
		await fixture.registry.createResource({ slug: 'default-context', fileId: uploaded.fileId })

		const result = await rpc(fixture.app, 'instances.create', createInstanceInput({
			presetId: 'edit',
			resourceIds: ['missing-resource'],
			fileIds: [],
		}))

		expect(result.ok).toBe(true)
		expect(fixture.calls.filter(call => call.startsWith('inject:'))).toEqual([])
		expect(fixture.warnings.map(warning => warning.message)).toContain(
			'Some input resourceIds did not match the local registry; ignoring',
		)
	})

	it('returns a controlled RPC error for malformed session-manager output', async () => {
		const fixture = await createFixture()
		fixture.returnMalformedSessionList()

		const result = await rpc(fixture.app, 'sessions.list', { instanceId: 'instance-1' })

		expect(result.ok).toBe(false)
		if (result.ok) throw new Error('Expected malformed collaborator output to fail')
		expect(result.error.type).toBe('handler_error')
		expect(result.error.message).toContain('sessions')
	})

	it('closes the SDK session and removes its worktree after injection failure', async () => {
		const fixture = await createFixture()
		const uploaded = await fixture.registry.uploadFile({
			buffer: Buffer.from('broken'),
			filename: 'broken.txt',
			mimeType: 'text/plain',
		})
		if ('error' in uploaded) throw new Error('Expected uploaded registry file')
		fixture.failNextInjection()

		const first = await rpc(fixture.app, 'instances.create', createInstanceInput({
			presetId: 'edit',
			fileIds: [uploaded.fileId],
		}))
		expect(first.ok).toBe(false)
		if (first.ok) throw new Error('Expected injection failure')
		expect(first.error.message).toContain('deterministic injection failure')
		expect(fixture.activeSessions.size).toBe(0)
		expect(fixture.worktrees.size).toBe(0)
		const leaseAcquireIndex = fixture.calls.findIndex(call => call.startsWith('session:lease:acquire:standalone:rollback:'))
		const closeIndex = fixture.calls.findIndex(call => call.startsWith('session:close:'))
		const leaseReleaseIndex = fixture.calls.findIndex(call => call.startsWith('session:lease:release:standalone:rollback:'))
		const removeIndex = fixture.calls.findIndex(call => call.startsWith('worktree:remove:'))
		expect(leaseAcquireIndex).toBeGreaterThan(-1)
		expect(closeIndex).toBeGreaterThan(-1)
		expect(closeIndex).toBeGreaterThan(leaseAcquireIndex)
		expect(leaseReleaseIndex).toBeGreaterThan(closeIndex)
		expect(removeIndex).toBeGreaterThan(closeIndex)

		const retry = await rpc(fixture.app, 'instances.create', createInstanceInput({
			presetId: 'edit',
			fileIds: [uploaded.fileId],
		}))
		expect(retry.ok).toBe(true)
		expect(fixture.activeSessions.size).toBe(1)
		expect(fixture.worktrees.size).toBe(1)
	})

	it.each(cleanupFailureCases)('preserves the injection error when $stage cleanup fails', async ({
		stage,
		expectedLog,
	}) => {
		const fixture = await createFixture()
		const uploaded = await fixture.registry.uploadFile({
			buffer: Buffer.from('broken'),
			filename: 'broken.txt',
			mimeType: 'text/plain',
		})
		if ('error' in uploaded) throw new Error('Expected uploaded registry file')
		fixture.failNextInjection()
		fixture.failCleanupAt(stage)

		const result = await rpc(fixture.app, 'instances.create', createInstanceInput({
			presetId: 'edit',
			fileIds: [uploaded.fileId],
		}))

		expect(result.ok).toBe(false)
		if (result.ok) throw new Error('Expected injection failure')
		expect(result.error.message).toContain('deterministic injection failure')
		expect(fixture.errors).toContain(expectedLog)
	})
})
