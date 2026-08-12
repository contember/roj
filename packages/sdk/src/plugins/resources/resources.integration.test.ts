import { afterEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Hono } from 'hono'
import { bootstrap, createSessionManager } from '~/bootstrap.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import { SAFE_INFO_ZIP_6_FIXTURE } from '~/lib/archive/archive-inspection.fixtures.js'
import { createNodePlatform, createTestPreset, TestHarness } from '~/testing/index.js'
import type { AppEnv, AppServices } from '~/transport/http/context.js'
import { createResourceRoutes } from '~/transport/http/routes/resources.js'
import { resourcesPlugin } from './plugin.js'
import { resourceEvents, type ResourcesState } from './state.js'

let currentHarness: TestHarness | undefined

afterEach(async () => {
	if (currentHarness) {
		await currentHarness.shutdown()
		currentHarness = undefined
	}
})

interface ZipInfoEntry {
	name: string
	size: number
	type: 'file' | 'directory'
}

function zipInfoFixture(entries: readonly ZipInfoEntry[]): string {
	const entryWord = entries.length === 1 ? 'entry' : 'entries'
	const details = entries.map((entry, index) => {
		const mode = entry.type === 'directory' ? '040755' : '100644'
		return `Central directory entry #${index + 1}:
---------------------------

  ${entry.name}

  file system or operating system of origin:      Unix
  uncompressed size:                              ${entry.size} bytes
  length of filename:                             ${Buffer.byteLength(entry.name)} characters
  Unix file attributes (${mode} octal):            attributes
  MS-DOS file attributes (00 hex):                none
`
	}).join('\n')

	return `Archive: fixture.zip
  This zipfile constitutes the sole disk of a single-part archive; its
  central directory contains ${entries.length} ${entryWord}.

${details}`
}

function resourceInput(overrides: Partial<{
	filename: string
	mimeType: string
	fileBuffer: Buffer
}> = {}) {
	const fileBuffer = overrides.fileBuffer ?? Buffer.from('content')
	return {
		sessionId: 'test-session',
		filename: overrides.filename ?? 'resource.txt',
		mimeType: overrides.mimeType ?? 'text/plain',
		size: fileBuffer.length,
		fileBuffer,
	}
}

async function createResourceHarness(
	workspaceDir: string,
	config: Parameters<typeof resourcesPlugin.configure>[0] = {},
) {
	const harness = new TestHarness({
		presets: [createTestPreset({ workspaceDir, plugins: [resourcesPlugin.configure(config)] })],
		llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
	})
	currentHarness = harness
	const session = await harness.createSession('test')
	return { harness, session }
}

describe('resources plugin', () => {
	it('resolves targetDir callback relative to workspace and records it in state', async () => {
		const workspaceDir = await mkdtemp(join(tmpdir(), 'roj-resources-'))
		const targetDir = join(workspaceDir, 'packages', 'web')

		try {
			const harness = new TestHarness({
				presets: [
					createTestPreset({
						workspaceDir,
						plugins: [
							resourcesPlugin.configure({
								targetDir: ({ sessionId, workspaceDir: resolvedWorkspaceDir }) => {
									expect(sessionId.length).toBeGreaterThan(0)
									expect(resolvedWorkspaceDir).toBe(workspaceDir)
									return 'packages/web'
								},
							}),
						],
					}),
				],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})
			currentHarness = harness

			const session = await harness.createSession('test')
			const result = await session.callPluginMethod('resources.inject', {
				sessionId: String(session.sessionId),
				filename: 'hello.txt',
				mimeType: 'text/plain',
				size: 5,
				fileBuffer: Buffer.from('hello'),
			})

			expect(result).toMatchObject({
				ok: true,
				value: { paths: ['hello.txt'] },
			})
			await expect(readFile(join(targetDir, 'hello.txt'), 'utf-8')).resolves.toBe('hello')

			const resources = session.getPluginState<ResourcesState>('resources')
			expect(resources?.resources[0]?.targetDir).toBe(targetDir)

			const events = await session.getEventsByType(resourceEvents, 'resource_injected')
			expect(events[0]?.targetDir).toBe(targetDir)
		} finally {
			await rm(workspaceDir, { recursive: true, force: true })
		}
	})

	const invalidFilenames = [
		'../outside.txt',
		'dir/file.txt',
		'dir\\file.txt',
		'/absolute.txt',
		'C:\\absolute.txt',
		'C:relative.txt',
		'bad\0name.txt',
		'.',
		'..',
	]

	it.each(invalidFilenames)('rejects a non-basename direct resource filename: %s', async (filename) => {
		const workspaceDir = await mkdtemp(join(tmpdir(), 'roj-resources-name-'))

		try {
			const { session } = await createResourceHarness(workspaceDir)
			const result = await session.callPluginMethod('resources.inject', resourceInput({ filename }))

			expect(result.ok).toBe(false)
			expect(await readdir(workspaceDir)).toEqual([])
		} finally {
			await rm(workspaceDir, { recursive: true, force: true })
		}
	})

	const rejectedListings: ReadonlyArray<readonly [string, string]> = [
		['too many entries', zipInfoFixture(Array.from({ length: 501 }, (_, index): ZipInfoEntry => ({
			name: `dir-${index}/`,
			size: 0,
			type: 'directory',
		})))],
		['too many bytes', zipInfoFixture([{ name: 'large.bin', size: 100 * 1024 * 1024 + 1, type: 'file' }])],
		['unsafe path', zipInfoFixture([{ name: '../outside.txt', size: 1, type: 'file' }])],
	]

	it.each(rejectedListings)('rejects %s before extraction and leaves the target unchanged', async (_case, listing) => {
		const workspaceDir = await mkdtemp(join(tmpdir(), 'roj-resources-inspect-'))
		await writeFile(join(workspaceDir, 'existing.txt'), 'unchanged')

		try {
			const { harness, session } = await createResourceHarness(workspaceDir)
			let extractionCalled = false
			let tempRoot: string | undefined
			const process = harness.sessionManager.getPlatform().process
			const originalExec = process.execFile.bind(process)
			process.execFile = async (file, args, options) => {
				if (file === 'unzip' && args[0] === '-Z') {
					const archivePath = args[2]
					if (archivePath !== undefined) tempRoot = dirname(archivePath)
					return { stdout: listing, stderr: '' }
				}
				if (file === 'unzip' && args[0] === '-q') {
					extractionCalled = true
					throw new Error('extraction must not run')
				}
				return originalExec(file, args, options)
			}

			await expect(session.callPluginMethod('resources.inject', resourceInput({
				filename: 'resource.zip',
				mimeType: 'application/zip',
			}))).rejects.toThrow('ZIP inspection failed')

			expect(extractionCalled).toBe(false)
			expect(await readdir(workspaceDir)).toEqual(['existing.txt'])
			expect(await readFile(join(workspaceDir, 'existing.txt'), 'utf-8')).toBe('unchanged')
			expect(tempRoot).toBeDefined()
			if (tempRoot !== undefined) {
				expect(await harness.sessionManager.getPlatform().fs.exists(tempRoot)).toBe(false)
			}
		} finally {
			await rm(workspaceDir, { recursive: true, force: true })
		}
	})

	it('applies resource-specific archive limits before extraction', async () => {
		const workspaceDir = await mkdtemp(join(tmpdir(), 'roj-resources-custom-limit-'))
		const listing = zipInfoFixture([
			{ name: 'one.txt', size: 1, type: 'file' },
			{ name: 'two.txt', size: 1, type: 'file' },
		])

		try {
			const { harness, session } = await createResourceHarness(workspaceDir, {
				archiveLimits: { maxEntries: 1 },
			})
			let extractionCalled = false
			const process = harness.sessionManager.getPlatform().process
			const originalExec = process.execFile.bind(process)
			process.execFile = async (file, args, options) => {
				if (file === 'unzip' && args[0] === '-Z') return { stdout: listing, stderr: '' }
				if (file === 'unzip' && args[0] === '-q') extractionCalled = true
				return originalExec(file, args, options)
			}

			await expect(session.callPluginMethod('resources.inject', resourceInput({
				filename: 'resource.zip',
				mimeType: 'application/zip',
			}))).rejects.toThrow('ZIP inspection failed')

			expect(extractionCalled).toBe(false)
			expect(await readdir(workspaceDir)).toEqual([])
		} finally {
			await rm(workspaceDir, { recursive: true, force: true })
		}
	})

	it('applies server-configured resource archive limits', async () => {
		const baseDir = await mkdtemp(join(tmpdir(), 'roj-resource-server-limit-'))
		const workspaceDir = join(baseDir, 'workspace')
		await mkdir(workspaceDir)
		const platform = createNodePlatform()
		let extractionCalled = false
		const listing = zipInfoFixture([
			{ name: 'one.txt', size: 1, type: 'file' },
			{ name: 'two.txt', size: 1, type: 'file' },
		])
		const originalExec = platform.process.execFile.bind(platform.process)
		platform.process.execFile = async (file, args, options) => {
			if (file === 'unzip' && args[0] === '-Z') return { stdout: listing, stderr: '' }
			if (file === 'unzip' && args[0] === '-q') extractionCalled = true
			return originalExec(file, args, options)
		}
		const services = bootstrap({
			port: 0,
			host: 'localhost',
			dataPath: baseDir,
			persistence: 'memory',
			logLevel: 'error',
			logFormat: 'console',
			resourceArchiveLimits: { maxEntries: 1 },
			llmMock: () => ({
				content: 'Mock response',
				toolCalls: [],
				finishReason: 'stop',
				metrics: { promptTokens: 0, completionTokens: 0, totalTokens: 0, latencyMs: 0, model: 'mock' },
			}),
		}, { presets: [createTestPreset({ workspaceDir })] }, platform)
		const sessionManager = createSessionManager(services)

		try {
			const sessionResult = await sessionManager.createSession('test', { workspaceDir })
			if (!sessionResult.ok) throw new Error(sessionResult.error.message)

			await expect(sessionResult.value.callPluginMethod('resources.inject', resourceInput({
				filename: 'resource.zip',
				mimeType: 'application/zip',
			}))).rejects.toThrow('ZIP inspection failed')

			expect(extractionCalled).toBe(false)
			expect(await readdir(workspaceDir)).toEqual([])
		} finally {
			await sessionManager.shutdown()
			await rm(baseDir, { recursive: true, force: true })
		}
	})

	it('cleans staging and leaves the target unchanged when extraction fails', async () => {
		const workspaceDir = await mkdtemp(join(tmpdir(), 'roj-resources-extract-'))
		await writeFile(join(workspaceDir, 'existing.txt'), 'unchanged')

		try {
			const { harness, session } = await createResourceHarness(workspaceDir)
			const calls: string[][] = []
			let tempRoot: string | undefined
			const process = harness.sessionManager.getPlatform().process
			const originalExec = process.execFile.bind(process)
			process.execFile = async (file, args, options) => {
				if (file !== 'unzip') return originalExec(file, args, options)
				calls.push(args)
				if (args[0] === '-Z') {
					const archivePath = args[2]
					if (archivePath !== undefined) tempRoot = dirname(archivePath)
					return { stdout: SAFE_INFO_ZIP_6_FIXTURE, stderr: '' }
				}
				throw new Error('unzip exited with code 2')
			}

			await expect(session.callPluginMethod('resources.inject', resourceInput({
				filename: 'resource.zip',
				mimeType: 'application/zip',
			}))).rejects.toThrow('unzip exited with code 2')

			expect(calls.map(args => args[0])).toEqual(['-Z', '-q'])
			expect(await readdir(workspaceDir)).toEqual(['existing.txt'])
			expect(await readFile(join(workspaceDir, 'existing.txt'), 'utf-8')).toBe('unchanged')
			if (tempRoot !== undefined) {
				expect(await harness.sessionManager.getPlatform().fs.exists(tempRoot)).toBe(false)
			}
		} finally {
			await rm(workspaceDir, { recursive: true, force: true })
		}
	})

	it('promotes a validated overlay, excludes unrelated files, and runs manifest hooks afterward', async () => {
		const workspaceDir = await mkdtemp(join(tmpdir(), 'roj-resources-overlay-'))
		const sourceDir = await mkdtemp(join(tmpdir(), 'roj-resources-source-'))
		const archivePath = join(sourceDir, 'resource.zip')
		await writeFile(join(workspaceDir, 'existing.txt'), 'keep')
		await writeFile(join(sourceDir, 'new.txt'), 'new')
		await writeFile(join(sourceDir, 'roj.resource.json'), JSON.stringify({
			postInject: [{ run: ['sh', '-c', 'printf manifest > manifest-ran.txt'] }],
		}))
		await mkdir(join(sourceDir, '.git'))
		await writeFile(join(sourceDir, '.git', 'HEAD'), 'do not inject')

		try {
			let configuredHookRan = false
			const { harness, session } = await createResourceHarness(workspaceDir, {
				postInject: async (ctx) => {
					configuredHookRan = true
					expect(ctx.paths).toEqual(['new.txt'])
					expect(await ctx.fs.readFile(join(ctx.targetDir, 'new.txt'), 'utf-8')).toBe('new')
					expect(await ctx.fs.exists(join(ctx.targetDir, 'roj.resource.json'))).toBe(false)
				},
			})
			const process = harness.sessionManager.getPlatform().process
			await process.execFile('zip', ['-q', '-r', archivePath, 'new.txt', 'roj.resource.json', '.git'], { cwd: sourceDir })
			const archive = await readFile(archivePath)

			const originalExec = process.execFile.bind(process)
			const calls: string[] = []
			let tempRoot: string | undefined
			process.execFile = async (file, args, options) => {
				if (file === 'unzip') {
					calls.push(args[0] ?? '')
					if (args[0] === '-Z' && args[2] !== undefined) tempRoot = dirname(args[2])
				}
				return originalExec(file, args, options)
			}

			const result = await session.callPluginMethod('resources.inject', resourceInput({
				filename: 'resource.zip',
				mimeType: 'application/zip',
				fileBuffer: archive,
			}))

			expect(result).toMatchObject({ ok: true, value: { paths: ['new.txt'] } })
			expect(calls.slice(0, 2)).toEqual(['-Z', '-q'])
			expect(configuredHookRan).toBe(true)
			expect(await readFile(join(workspaceDir, 'existing.txt'), 'utf-8')).toBe('keep')
			expect(await readFile(join(workspaceDir, 'new.txt'), 'utf-8')).toBe('new')
			expect(await readFile(join(workspaceDir, 'manifest-ran.txt'), 'utf-8')).toBe('manifest')
			expect(await harness.sessionManager.getPlatform().fs.exists(join(workspaceDir, '.git'))).toBe(false)
			expect(await harness.sessionManager.getPlatform().fs.exists(join(workspaceDir, 'roj.resource.json'))).toBe(false)
			if (tempRoot !== undefined) {
				expect(await harness.sessionManager.getPlatform().fs.exists(tempRoot)).toBe(false)
			}
		} finally {
			await rm(workspaceDir, { recursive: true, force: true })
			await rm(sourceDir, { recursive: true, force: true })
		}
	})

	it('normalizes archive aliases before excluding .git and the manifest', async () => {
		const workspaceDir = await mkdtemp(join(tmpdir(), 'roj-resources-aliases-'))
		const listing = zipInfoFixture([
			{ name: './.git/HEAD', size: 3, type: 'file' },
			{ name: 'nested//file.txt', size: 4, type: 'file' },
			{ name: './roj.resource.json', size: 2, type: 'file' },
		])

		try {
			const { harness, session } = await createResourceHarness(workspaceDir)
			const process = harness.sessionManager.getPlatform().process
			const originalExec = process.execFile.bind(process)
			process.execFile = async (file, args, options) => {
				if (file !== 'unzip') return originalExec(file, args, options)
				if (args[0] === '-Z') return { stdout: listing, stderr: '' }

				const stagingDir = args[3]
				if (stagingDir === undefined) throw new Error('missing staging directory')
				await mkdir(join(stagingDir, '.git'), { recursive: true })
				await writeFile(join(stagingDir, '.git', 'HEAD'), 'git')
				await mkdir(join(stagingDir, 'nested'), { recursive: true })
				await writeFile(join(stagingDir, 'nested', 'file.txt'), 'file')
				await writeFile(join(stagingDir, 'roj.resource.json'), '{}')
				return { stdout: '', stderr: '' }
			}

			const result = await session.callPluginMethod('resources.inject', resourceInput({
				filename: 'resource.zip',
				mimeType: 'application/zip',
			}))

			expect(result).toMatchObject({ ok: true, value: { paths: ['nested/file.txt'] } })
			expect(await readFile(join(workspaceDir, 'nested', 'file.txt'), 'utf-8')).toBe('file')
			expect(await harness.sessionManager.getPlatform().fs.exists(join(workspaceDir, '.git'))).toBe(false)
			expect(await harness.sessionManager.getPlatform().fs.exists(join(workspaceDir, 'roj.resource.json'))).toBe(false)
		} finally {
			await rm(workspaceDir, { recursive: true, force: true })
		}
	})

	it('returns a controlled validation response for non-string HTTP fields', async () => {
		const baseDir = await mkdtemp(join(tmpdir(), 'roj-resource-route-'))
		const workspaceDir = join(baseDir, 'workspace')
		await mkdir(workspaceDir)
		const platform = createNodePlatform()
		const services = bootstrap({
			port: 0,
			host: 'localhost',
			dataPath: baseDir,
			persistence: 'memory',
			logLevel: 'error',
			logFormat: 'console',
			llmMock: () => ({
				content: 'Mock response',
				toolCalls: [],
				finishReason: 'stop',
				metrics: { promptTokens: 0, completionTokens: 0, totalTokens: 0, latencyMs: 0, model: 'mock' },
			}),
		}, { presets: [createTestPreset()] }, platform)
		const sessionRuntime = createSessionManager(services)

		try {
			const sessionResult = await sessionRuntime.createSession('test', { workspaceDir })
			if (!sessionResult.ok) throw new Error(sessionResult.error.message)
			const appServices: AppServices = { ...services, sessionRuntime }
			const app = new Hono<AppEnv>()
			app.use('*', async (context, next) => {
				context.set('services', appServices)
				await next()
			})
			app.route('/sessions', createResourceRoutes())

			const response = await app.request(`/sessions/${sessionResult.value.id}/inject-resource`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ url: 'https://example.test/resource', filename: 42, mimeType: 'text/plain' }),
			})

			expect(response.status).toBe(400)
			expect(await response.text()).toContain('validation_error')
		} finally {
			await sessionRuntime.shutdown()
			await rm(baseDir, { recursive: true, force: true })
		}
	})
})
