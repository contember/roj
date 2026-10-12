/**
 * Builds the modules a host hands to the Worker Loader to run the runtime as a facet.
 *
 * The SDK is built once per runtime version and shared by every app bundle. An app
 * bundle is `roj build` output in `externalSdk` mode: it imports `@roj-ai/sdk` and its
 * subpaths as bare specifiers, which resolve to small shim modules re-exporting the
 * shared build. The runtime's main module imports the same shims, so the app and the
 * runtime share one SDK instance.
 *
 * The loader resolves a specifier relative to the importing module's directory, a bare
 * one included. The shims sit at the root, so the app bundle and the main module reach
 * them by name; the shims reach the SDK by absolute path.
 */

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'

/** A Worker Loader module: a `.js` name maps to ES module source, any other name needs its type. */
export type LoaderModule = string | { js: string }

export interface RuntimeModules {
	mainModule: string
	modules: Record<string, LoaderModule>
}

/** The module name the main module imports the app's config from. */
export const APP_BUNDLE_MODULE = 'roj-app-bundle'

const MAIN_MODULE = 'main.js'
const SDK_DIR = 'sdk'
const PLATFORM_EXTERNALS = ['node:*', 'cloudflare:*']
/** SDK subpaths an isolate cannot run or an app bundle has no use for. */
const EXCLUDED_SDK_EXPORTS = new Set(['./package.json', './bun-platform', './testing'])

const packageRoot = join(import.meta.dir, '..')

async function bunBuild(options: Parameters<typeof Bun.build>[0]): Promise<void> {
	const result = await Bun.build({ target: 'node', format: 'esm', ...options })
	if (!result.success) throw new AggregateError(result.logs, 'isolate runtime build failed')
}

async function sdkSubpaths(): Promise<string[]> {
	const manifestPath = Bun.resolveSync('@roj-ai/sdk/package.json', packageRoot)
	const manifest: { exports: Record<string, unknown>; roj?: { bunOnlyExports?: string[] } } = await Bun.file(manifestPath).json()
	const bunOnly = new Set(manifest.roj?.bunOnlyExports ?? [])
	return Object.keys(manifest.exports).filter(subpath => !EXCLUDED_SDK_EXPORTS.has(subpath) && !bunOnly.has(subpath))
}

/** `.` → `@roj-ai/sdk`, `./tools/shell` → `@roj-ai/sdk/tools/shell`. */
const specifierOf = (subpath: string) => (subpath === '.' ? '@roj-ai/sdk' : `@roj-ai/sdk/${subpath.slice(2)}`)
/** `.` → `index`, `./tools/shell` → `tools__shell`: flat, so every entry lands in one directory. */
const entryNameOf = (subpath: string) => (subpath === '.' ? 'index' : subpath.slice(2).replaceAll('/', '__'))

async function readModules(dir: string, prefix: string): Promise<Record<string, string>> {
	const modules: Record<string, string> = {}
	for (const file of await readdir(dir)) {
		modules[posix.join(prefix, file)] = await readFile(join(dir, file), 'utf8')
	}
	return modules
}

/** Builds the runtime from the installed `@roj-ai/*` packages. Needs Bun. */
export async function buildRuntimeModules(): Promise<RuntimeModules> {
	// Entries must resolve `@roj-ai/sdk` the way this package does, so they live inside it.
	const workDir = join(packageRoot, `.isolate-build-${crypto.randomUUID()}`)
	try {
		const subpaths = await sdkSubpaths()
		const entriesDir = join(workDir, 'entries')
		await mkdir(entriesDir, { recursive: true })
		const entries: string[] = []
		for (const subpath of subpaths) {
			const entry = join(entriesDir, `${entryNameOf(subpath)}.ts`)
			await writeFile(entry, `export * from '${specifierOf(subpath)}'\n`)
			entries.push(entry)
		}

		await bunBuild({
			entrypoints: entries,
			outdir: join(workDir, SDK_DIR),
			splitting: true,
			external: PLATFORM_EXTERNALS,
			naming: { entry: '[name].js', chunk: 'chunk-[hash].js' },
		})
		await bunBuild({
			entrypoints: [join(packageRoot, 'src/worker/main.ts')],
			outdir: join(workDir, 'main'),
			naming: MAIN_MODULE,
			external: [...PLATFORM_EXTERNALS, '@roj-ai/sdk', '@roj-ai/sdk/*', APP_BUNDLE_MODULE],
		})

		const modules: Record<string, LoaderModule> = {
			[MAIN_MODULE]: await readFile(join(workDir, 'main', MAIN_MODULE), 'utf8'),
			...(await readModules(join(workDir, SDK_DIR), SDK_DIR)),
		}
		for (const subpath of subpaths) {
			modules[specifierOf(subpath)] = { js: `export * from '/${SDK_DIR}/${entryNameOf(subpath)}.js'\n` }
		}
		return { mainModule: MAIN_MODULE, modules }
	} finally {
		await rm(workDir, { recursive: true, force: true })
	}
}

/** The runtime's modules plus one app bundle: what a host passes to `LOADER.get()`. */
export function withAppBundle(runtime: RuntimeModules, appBundle: string): RuntimeModules {
	return { mainModule: runtime.mainModule, modules: { ...runtime.modules, [APP_BUNDLE_MODULE]: { js: appBundle } } }
}

const STATIC_IMPORT = /^(?:import|export)\b[^;'"]*?\bfrom\s*["']([^"']+)["']|^import\s*["']([^"']+)["']/gm
const DYNAMIC_IMPORT = /\bimport\(\s*["']([^"']+)["']\s*\)/g

/**
 * Imports that would not resolve under the loader's rules. Bun's unminified ESM output
 * keeps every static import at the start of a line, which is what the scan relies on.
 * Platform builtins (`node:`, `cloudflare:`) are not checked.
 */
export function unresolvedImports(modules: Record<string, LoaderModule>): { module: string; specifier: string }[] {
	const missing: { module: string; specifier: string }[] = []
	for (const [name, module] of Object.entries(modules)) {
		const source = typeof module === 'string' ? module : module.js
		const specifiers = [
			...[...source.matchAll(STATIC_IMPORT)].map(match => match[1] ?? match[2]),
			...[...source.matchAll(DYNAMIC_IMPORT)].map(match => match[1]),
		]
		for (const specifier of specifiers) {
			if (specifier === undefined || /^(?:node|cloudflare):/.test(specifier)) continue
			const resolved = specifier.startsWith('/') ? specifier.slice(1) : posix.join(dirname(name), specifier)
			if (!(resolved in modules)) missing.push({ module: name, specifier })
		}
	}
	return missing
}
