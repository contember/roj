import { resolve, dirname, join } from 'node:path'
import { writeFile, rm, mkdir } from 'node:fs/promises'

export async function build(configPath: string, outPath: string): Promise<void> {
	const absConfig = resolve(configPath)
	const absOut = resolve(outPath)
	const configDir = dirname(absConfig)

	// Generate entry next to config (so Bun resolves workspace packages)
	const entryPath = join(configDir, '.roj-entry.ts')

	await writeFile(entryPath, `
import config from '${absConfig}'
import { startServer } from '@roj-ai/sandbox-runtime/server'
startServer({ presets: config.presets }).catch((err) => {
	console.error('Fatal:', err)
	process.exit(1)
})
`)

	try {
		await mkdir(dirname(absOut), { recursive: true })

		const result = await Bun.build({
			entrypoints: [entryPath],
			outdir: dirname(absOut),
			naming: absOut.split('/').pop()!,
			target: 'bun',
		})

		if (!result.success) {
			for (const log of result.logs) {
				console.error(log)
			}
			process.exit(1)
		}

		const stat = Bun.file(absOut)
		console.log(`Built: ${absOut} (${(stat.size / 1024).toFixed(0)} KB)`)
	} finally {
		await rm(entryPath).catch(() => {})
	}
}
