import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { lstat, mkdir, realpath, rm, symlink } from 'node:fs/promises'
import { constants } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const RELAUNCHED_ENV = 'ROJ_SANDBOX_RUNTIME_RELAUNCHED'
const FORWARDED_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const

/**
 * Makes `import "@roj-ai/*"` in a bundle built with `runtime.external = true` resolve to the
 * runtime's installed copy, by linking `<bundleDir>/node_modules/@roj-ai` to it.
 *
 * @returns true when it created the link, false when an installed SDK or a link to this runtime's copy was
 * already there.
 */
async function ensureSdkResolvable(bundleDir: string): Promise<boolean> {
	const runtimeReq = createRequire(import.meta.url)
	const sdkPkgPath = runtimeReq.resolve('@roj-ai/sdk/package.json')
	const runtimeRojDir = resolve(sdkPkgPath, '..', '..')
	const linkPath = join(bundleDir, 'node_modules', '@roj-ai')

	// A link left by another runtime version would load that version's SDK next to this runtime's.
	const existingLink = await lstat(linkPath).then(stat => stat.isSymbolicLink(), () => false)
	if (existingLink) {
		const [linkedDir, runtimeDir] = await Promise.all([realpath(linkPath).catch(() => null), realpath(runtimeRojDir)])
		if (linkedDir === runtimeDir) return false
	} else if (hasInstalledSdk(bundleDir)) {
		return false
	}

	await rm(linkPath, { recursive: true, force: true })
	await mkdir(dirname(linkPath), { recursive: true })
	await symlink(runtimeRojDir, linkPath, 'dir')
	console.log(`[sandbox-runtime] linked ${linkPath} → ${runtimeRojDir}`)
	return true
}

/**
 * Looks for `node_modules/@roj-ai/sdk` in the bundle's directory and above, without the resolver: with no
 * `node_modules` above the bundle, Bun auto-installs a missing package, which would load a second SDK.
 */
function hasInstalledSdk(fromDir: string): boolean {
	for (let dir = resolve(fromDir); ; dir = dirname(dir)) {
		if (existsSync(join(dir, 'node_modules', '@roj-ai', 'sdk', 'package.json'))) return true
		if (dirname(dir) === dir) return false
	}
}

/**
 * Links the SDK for the bundle and, when the link is new, runs this command once more and waits for it.
 * Bun caches the working directory's entries at startup, so this process would not see a link created
 * there, and a host usually starts the runtime in the bundle's directory.
 *
 * @returns the relaunched process's exit code, or null when this process can load the bundle itself.
 */
export async function linkSdkOrRelaunch(bundleDir: string): Promise<number | null> {
	// The marker holds the relaunching parent's pid: processes the agent starts inherit the env, and a runtime
	// among them must still relaunch for its own bundle.
	const relaunched = process.env[RELAUNCHED_ENV] === String(process.ppid)
	const linked = await ensureSdkResolvable(bundleDir)
	if (!linked || relaunched) return null

	console.log('[sandbox-runtime] restarting so the new link is resolvable')
	const child = Bun.spawn([process.execPath, ...process.execArgv, ...process.argv.slice(1)], {
		env: { ...process.env, [RELAUNCHED_ENV]: String(process.pid) },
		stdio: ['inherit', 'inherit', 'inherit'],
	})
	for (const signal of FORWARDED_SIGNALS) {
		process.on(signal, () => child.kill(signal))
	}
	await child.exited
	if (child.exitCode !== null) return child.exitCode
	return 128 + (child.signalCode ? constants.signals[child.signalCode] : 0)
}
