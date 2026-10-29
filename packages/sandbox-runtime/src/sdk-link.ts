import { createRequire } from 'node:module'
import { mkdir, rm, symlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/**
 * Makes `import "@roj-ai/*"` in a bundle built with `runtime.external = true` resolve to the
 * runtime's installed copy, by linking `<bundleDir>/node_modules/@roj-ai` to it.
 */
export async function ensureSdkResolvable(bundleDir: string): Promise<void> {
	const userReq = createRequire(join(bundleDir, '__roj_anchor__'))
	try {
		userReq.resolve('@roj-ai/sdk/package.json')
		return
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
}

