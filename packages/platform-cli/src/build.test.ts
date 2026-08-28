import { describe, expect, it } from 'bun:test'
import { entrySource } from './build.js'

describe('bundle entry source', () => {
	it('hands the whole config to startServer, not just its presets', () => {
		const source = entrySource('/app/roj.config.ts', false)
		expect(source).toContain('startServer(config)')
		expect(source).not.toContain('config.presets')
	})

	it('re-exports the config untouched for an external-SDK bundle', () => {
		const source = entrySource('/app/roj.config.ts', true)
		expect(source).toContain("import config from '/app/roj.config.ts'")
		expect(source).toContain('export default config')
	})
})
