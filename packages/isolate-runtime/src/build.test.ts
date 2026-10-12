import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { APP_BUNDLE_MODULE, buildRuntimeModules, type RuntimeModules, unresolvedImports, withAppBundle } from './build.js'

const packageRoot = join(import.meta.dir, '..')
let workDir: string
let runtime: RuntimeModules
let appBundle: string

const APP_CONFIG = `
import { createOrchestrator, createPreset, ModelId } from '@roj-ai/sdk'
import { defineConfig } from '@roj-ai/sdk/user-config'
import { filesystemPlugin } from '@roj-ai/sdk/tools/filesystem'

export default defineConfig({
	presets: [
		createPreset({
			id: 'app',
			name: 'App',
			plugins: [filesystemPlugin.configure({})],
			orchestrator: createOrchestrator({ system: 'Help.', model: ModelId('mock/model'), plugins: [], tools: [], agents: [] }),
		}),
	],
})
`

beforeAll(async () => {
	runtime = await buildRuntimeModules()
	// The fixture must resolve `@roj-ai/sdk` like an app does, so it is written inside this package.
	workDir = await mkdtemp(join(packageRoot, '.build-test-'))
	await writeFile(join(workDir, 'roj.config.ts'), APP_CONFIG)
	// The options `roj build` uses for an externalSdk bundle.
	const result = await Bun.build({
		entrypoints: [join(workDir, 'roj.config.ts')],
		outdir: join(workDir, 'out'),
		naming: 'bundle.js',
		target: 'bun',
		format: 'esm',
		external: ['@roj-ai/*'],
	})
	expect(result.success).toBe(true)
	appBundle = await readFile(join(workDir, 'out/bundle.js'), 'utf8')
}, 60_000)

afterAll(async () => {
	await rm(workDir, { recursive: true, force: true })
})

describe('buildRuntimeModules', () => {
	test('every import of the runtime and of a roj build bundle resolves under the loader rules', () => {
		const { mainModule, modules } = withAppBundle(runtime, appBundle)

		expect(mainModule).toBe('main.js')
		expect(modules[APP_BUNDLE_MODULE]).toEqual({ js: appBundle })
		expect(unresolvedImports(modules)).toEqual([])
	})

	test('shares one SDK build between the runtime and the app', () => {
		const sdkSources = Object.keys(runtime.modules).filter(name => name.startsWith('sdk/'))

		expect(runtime.modules['@roj-ai/sdk']).toEqual({ js: "export * from '/sdk/index.js'\n" })
		expect(runtime.modules['@roj-ai/sdk/tools/filesystem']).toEqual({ js: "export * from '/sdk/tools__filesystem.js'\n" })
		expect(sdkSources).toContain('sdk/index.js')
		// The main module imports the SDK by name instead of bundling a second copy.
		expect(runtime.modules['main.js']).toContain('"@roj-ai/sdk"')
	})

	test('reports an import the map cannot satisfy', () => {
		const modules = { 'main.js': 'import { x } from "@roj-ai/transport"\nexport * from "./missing.js"\nimport "node:fs"\n' }

		expect(unresolvedImports(modules)).toEqual([
			{ module: 'main.js', specifier: '@roj-ai/transport' },
			{ module: 'main.js', specifier: './missing.js' },
		])
	})
})
