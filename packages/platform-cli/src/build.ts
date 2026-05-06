import { resolve, dirname, join } from 'node:path'
import { writeFile, rm, mkdir } from 'node:fs/promises'

interface BundleMetadata {
	bundleMode: 'selfContained' | 'externalSdk'
	rojVersion?: string
	lockMinor?: boolean
}

export async function build(configPath: string, outPath: string): Promise<void> {
	const absConfig = resolve(configPath)
	const absOut = resolve(outPath)
	const configDir = dirname(absConfig)

	const userConfigModule = await import(absConfig)
	const userConfig = userConfigModule.default
	const isExternal = userConfig?.runtime?.external === true
	const lockMinor = userConfig?.runtime?.lockMinor ?? true

	const entryPath = join(configDir, '.roj-entry.ts')
	const entrySource = isExternal
		? `import config from '${absConfig}'\nexport default config\n`
		: `
import config from '${absConfig}'
import { startServer } from '@roj-ai/sandbox-runtime/server'
startServer({ presets: config.presets }).catch((err) => {
	console.error('Fatal:', err)
	process.exit(1)
})
`

	await writeFile(entryPath, entrySource)

	try {
		await mkdir(dirname(absOut), { recursive: true })

		const buildOptions: Parameters<typeof Bun.build>[0] = {
			entrypoints: [entryPath],
			outdir: dirname(absOut),
			naming: absOut.split('/').pop()!,
			target: 'bun',
		}
		if (isExternal) {
			buildOptions.external = ['@roj-ai/*']
			buildOptions.format = 'esm'
		}

		const result = await Bun.build(buildOptions)

		if (!result.success) {
			for (const log of result.logs) {
				console.error(log)
			}
			process.exit(1)
		}

		const stat = Bun.file(absOut)
		const sizeKb = stat.size / 1024
		console.log(`Built: ${absOut} (${sizeKb.toFixed(0)} KB)`)

		const metadata: BundleMetadata = isExternal
			? {
					bundleMode: 'externalSdk',
					rojVersion: await resolveSdkVersion(configDir),
					lockMinor,
				}
			: { bundleMode: 'selfContained' }

		const metaPath = `${absOut}.meta.json`
		await writeFile(metaPath, `${JSON.stringify(metadata, null, 2)}\n`)
		console.log(`Wrote metadata: ${metaPath}`)

		if (isExternal && sizeKb > 200) {
			console.warn(`[warn] external-sdk bundle is ${sizeKb.toFixed(0)} KB — externalization may not have taken full effect; check that user code does not pull @roj-ai/* via re-export.`)
		}
	} finally {
		await rm(entryPath).catch(() => {})
	}
}

async function resolveSdkVersion(configDir: string): Promise<string> {
	const pkgPath = Bun.resolveSync('@roj-ai/sdk/package.json', configDir)
	const pkg = await Bun.file(pkgPath).json() as { version: string }
	return pkg.version
}
