/**
 * The ZIP verify step against a platform that answers `scopeReads` and one that
 * does not — same injected paths, one shared read scope instead of loose stats.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockLLMProvider } from '~/core/llm/mock.js'
import { SAFE_INFO_ZIP_6_FIXTURE } from '~/lib/archive/archive-inspection.fixtures.js'
import type { FileSystem } from '~/platform/fs.js'
import { createTestPreset, TestHarness } from '~/testing/index.js'
import { resourcesPlugin } from './plugin.js'

/** The file entries of SAFE_INFO_ZIP_6_FIXTURE, which `unzip -q` is stubbed to produce. */
const EXTRACTED = ['regular.txt', 'space ž.txt']

let currentHarness: TestHarness | undefined

afterEach(async () => {
	await currentHarness?.shutdown()
	currentHarness = undefined
})

interface ScopeReport {
	scopes: number
	statsInsideScope: number
	statsOutsideScope: number
}

/** Reports how the resources verify step reached the staging tree it just extracted. */
function watchStagingReads(fs: FileSystem, withScopeReads: boolean): ScopeReport {
	const report: ScopeReport = { scopes: 0, statsInsideScope: 0, statsOutsideScope: 0 }
	let depth = 0
	const stat = fs.stat.bind(fs)
	fs.stat = (path) => {
		if (path.includes('_tmp_resource_')) {
			if (depth > 0) report.statsInsideScope++
			else report.statsOutsideScope++
		}
		return stat(path)
	}
	if (withScopeReads) {
		fs.scopeReads = async (fn) => {
			report.scopes++
			depth++
			try {
				return await fn()
			} finally {
				depth--
			}
		}
	}
	return report
}

async function injectZip(workspaceDir: string, withScopeReads: boolean) {
	const harness = new TestHarness({
		presets: [createTestPreset({ workspaceDir, plugins: [resourcesPlugin.configure({})] })],
		llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
	})
	currentHarness = harness
	const platform = harness.sessionManager.getPlatform()
	const report = watchStagingReads(platform.fs, withScopeReads)

	const originalExec = platform.process.execFile.bind(platform.process)
	platform.process.execFile = async (file, args, options) => {
		if (file === 'unzip' && args[0] === '-Z') return { stdout: SAFE_INFO_ZIP_6_FIXTURE, stderr: '' }
		if (file === 'unzip' && args[0] === '-q') {
			const stagingDir = args[3] ?? ''
			for (const name of EXTRACTED) await writeFile(join(stagingDir, name), name)
			return { stdout: '', stderr: '' }
		}
		return originalExec(file, args, options)
	}

	const session = await harness.createSession('test')
	const fileBuffer = Buffer.from('zip')
	const result = await session.callPluginMethod('resources.inject', {
		sessionId: String(session.sessionId),
		filename: 'resource.zip',
		mimeType: 'application/zip',
		size: fileBuffer.length,
		fileBuffer,
	})

	await harness.shutdown()
	currentHarness = undefined
	return { result, report }
}

describe('resources verify with and without scopeReads', () => {
	test('injects the same paths either way, and the stats land inside the scope', async () => {
		const plainDir = await mkdtemp(join(tmpdir(), 'roj-resources-plain-'))
		const scopedDir = await mkdtemp(join(tmpdir(), 'roj-resources-scoped-'))
		try {
			const plain = await injectZip(plainDir, false)
			const scoped = await injectZip(scopedDir, true)

			// `resourceId` is a fresh UUID per injection; everything else must match.
			expect(plain.result).toMatchObject({ ok: true, value: { paths: EXTRACTED } })
			expect(scoped.result).toMatchObject({ ok: true, value: { paths: EXTRACTED } })

			// Neither run is the other in disguise: one verified in a scope, one loose.
			expect(scoped.report.scopes).toBeGreaterThan(0)
			expect(scoped.report.statsInsideScope).toBe(EXTRACTED.length)
			expect(scoped.report.statsOutsideScope).toBe(0)
			expect(plain.report).toEqual({ scopes: 0, statsInsideScope: 0, statsOutsideScope: EXTRACTED.length })
		} finally {
			await rm(plainDir, { recursive: true, force: true })
			await rm(scopedDir, { recursive: true, force: true })
		}
	})
})
