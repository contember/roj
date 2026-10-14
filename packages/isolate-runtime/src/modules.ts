/**
 * The Worker Loader module map a host builds once per runtime version (`./build`) and completes with
 * one app bundle per instance. Free of Bun and Node APIs, so a host can use it inside a Worker.
 */

/** A Worker Loader module: a `.js` name maps to ES module source, any other name needs its type. */
export type LoaderModule = string | { js: string }

export interface RuntimeModules {
	mainModule: string
	modules: Record<string, LoaderModule>
}

/** The module name the main module imports the app's config from. */
export const APP_BUNDLE_MODULE = 'roj-app-bundle'

/** The runtime's modules plus one app bundle: what a host passes to `LOADER.get()`. */
export function withAppBundle(runtime: RuntimeModules, appBundle: string): RuntimeModules {
	return { mainModule: runtime.mainModule, modules: { ...runtime.modules, [APP_BUNDLE_MODULE]: { js: appBundle } } }
}

/** The loader resolves a specifier against the importing module's directory, a bare one included. */
function resolveModuleName(importer: string, specifier: string): string {
	if (specifier.startsWith('/')) return specifier.slice(1)
	const parts = importer.split('/').slice(0, -1)
	for (const part of specifier.split('/')) {
		if (part === '..') parts.pop()
		else if (part !== '.') parts.push(part)
	}
	return parts.join('/')
}

const STATIC_IMPORT = /^(?:import|export)\b[^;'"]*?\bfrom\s*["']([^"']+)["']|^import\s*["']([^"']+)["']/gm
const DYNAMIC_IMPORT = /\bimport\(\s*["']([^"']+)["']\s*\)/g
/** Bun's `target: 'bun'` output loads CommonJS dependencies through it; workerd has no such API. */
const BUN_REQUIRE = 'import.meta.require'

/**
 * Imports that would not resolve under the loader's rules, plus any use of `import.meta.require`,
 * reported with that as the specifier. Bun's unminified ESM output keeps every static import at the
 * start of a line, which is what the scan relies on. Platform builtins (`node:`, `cloudflare:`) are not checked.
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
			if (!(resolveModuleName(name, specifier) in modules)) missing.push({ module: name, specifier })
		}
		if (source.includes(BUN_REQUIRE)) missing.push({ module: name, specifier: BUN_REQUIRE })
	}
	return missing
}
