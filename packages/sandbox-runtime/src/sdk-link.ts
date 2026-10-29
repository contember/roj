import { createRequire } from 'node:module'
import { mkdir, rm, symlink } from 'node:fs/promises'
import { constants } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const RELAUNCHED_ENV = 'ROJ_SANDBOX_RUNTIME_RELAUNCHED'
const FORWARDED_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const

/**
 * Makes `import "@roj-ai/*"` in a bundle built with `runtime.external = true` resolve to the
 * runtime's installed copy, by linking `<bundleDir>/node_modules/@roj-ai` to it.
 *
 * @returns true when it created the link, false when the SDK was already resolvable.
 */
async function ensureSdkResolvable(bundleDir: string): Promise<boolean> {
	const userReq = createRequire(join(bundleDir, '__roj_anchor__'))
	try {
		userReq.resolve('@roj-ai/sdk/package.json')
		return false
	} catch {
		// Not resolvable — fall through to symlink path.
	}

	const runtimeReq = createRequire(import.meta.url)
	const sdkPkgPath = runtimeReq.resolve('@roj-ai/sdk/package.json')
	const runtimeRojDir = resolve(sdkPkgPath, '..', '..')

	const linkPath = join(bundleDir, 'node_modules', '@roj-ai')
	await rm(linkPath, { recursive: true, force: true })
	await mkdir(dirname(linkPath), { recursive: true })
	await symlink(runtimeRojDir, linkPath, 'dir')
	console.log(`[sandbox-runtime] linked ${linkPath} → ${runtimeRojDir}`)
	return true
}

/**
 * Links the SDK for the bundle and, when the link is new, runs this command once more and waits for it.
 * Bun caches the working directory's entries at startup, so this process would not see a link created
 * there, and a host usually starts the runtime in the bundle's directory.
 *
 * @returns the relaunched process's exit code, or null when this process can load the bundle itself.
 */
export async function linkSdkOrRelaunch(bundleDir: string): Promise<number | null> {
	const linked = await ensureSdkResolvable(bundleDir)
	if (!linked || process.env[RELAUNCHED_ENV]) return null

	console.log('[sandbox-runtime] restarting so the new link is resolvable')
	const child = Bun.spawn([process.execPath, ...process.execArgv, ...process.argv.slice(1)], {
		env: { ...process.env, [RELAUNCHED_ENV]: '1' },
		stdio: ['inherit', 'inherit', 'inherit'],
	})
	for (const signal of FORWARDED_SIGNALS) {
		process.on(signal, () => child.kill(signal))
	}
	await child.exited
	if (child.exitCode !== null) return child.exitCode
	return 128 + (child.signalCode ? constants.signals[child.signalCode] : 0)
}
