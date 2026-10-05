import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { createBunShellRunner } from '~/bun-platform/shell.js'
import type { ShellRunner } from '~/platform/shell.js'
import { checksFor, type ConformanceTarget, probePlatformPorts, runConformanceCheck } from './conformance.js'
import { createNodePlatform } from './node-platform.js'

function targetFor(shell: ShellRunner | undefined): ConformanceTarget {
	return {
		name: 'legacy shell compatibility',
		async create() {
			const root = await mkdtemp('/tmp/roj-shell-conformance-')
			return {
				platform: { ...createNodePlatform(), shell },
				root,
				dispose: () => rm(root, { recursive: true, force: true }),
			}
		},
	}
}

describe('shell timeout capability compatibility', () => {
	const bunRunner = createBunShellRunner()
	const legacyRunner: ShellRunner = { confinement: 'none', run: (options) => bunRunner.run(options) }

	test('omission preserves the legacy timeout obligation and passes real shell checks', async () => {
		const target = targetFor(legacyRunner)
		const support = await probePlatformPorts(target)
		expect(support.find((entry) => entry.port === 'shell.timeout')).toEqual({ port: 'shell.timeout', answered: true })
		for (const check of checksFor(['shell', 'shell.timeout'])) {
			await runConformanceCheck(target, check)
		}
	})

	test('only explicit false opts an existing runner out of timeout checks', async () => {
		for (const supportsTimeout of [true, false]) {
			const target = targetFor({ ...legacyRunner, supportsTimeout })
			const support = await probePlatformPorts(target)
			const timeout = support.find((entry) => entry.port === 'shell.timeout')
			expect(timeout?.answered).toBe(supportsTimeout)
			if (!supportsTimeout) expect(timeout?.note).toContain('no wall-clock timeout support')
		}
		const absent = await probePlatformPorts(targetFor(undefined))
		expect(absent.find((entry) => entry.port === 'shell.timeout')).toEqual({ port: 'shell.timeout', answered: false, note: 'port absent' })
	})

	test('a legacy runner that ignores timeouts fails instead of silently skipping', async () => {
		const target = targetFor({
			confinement: 'none',
			run: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false }),
		})
		const answered = (await probePlatformPorts(target)).filter((entry) => entry.answered).map((entry) => entry.port)
		const check = checksFor(answered).find((entry) => entry.name === 'a timeout terminates the command and reports timedOut')
		if (!check) throw new Error('legacy timeout check was skipped')
		await expect(runConformanceCheck(target, check)).rejects.toThrow()
	})
})
