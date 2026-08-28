import { describe, expect, it } from 'bun:test'
import type { Preset } from '~/core/preset/index.js'
import { filesystemPlugin } from '~/plugins/filesystem/index.js'
import { shellPlugin } from '~/plugins/shell/index.js'
import { createTestPreset } from '~/testing/preset-helpers.js'
import { applySandboxSettings, describeSandboxPosture, type RojConfig } from './user-config.js'

const bind = { path: '/opt/tools', mode: 'ro' as const }
const presetBind = { path: '/srv/preset', mode: 'rw' as const }

function preset(id: string, overrides?: Partial<Preset>): Preset {
	return { ...createTestPreset({ id }), ...overrides }
}

function pluginConfigOf(result: Preset, index = 0): unknown {
	return result.plugins?.[index].config
}

describe('applySandboxSettings', () => {
	describe('sandboxed precedence', () => {
		it('falls back to the top-level config when the preset is silent', () => {
			const config: RojConfig = { sandboxed: true, presets: [preset('a')] }
			expect(applySandboxSettings(config)[0].sandboxed).toBe(true)
		})

		it('keeps an explicit preset opt-out over an enabled top-level config', () => {
			const config: RojConfig = { sandboxed: true, presets: [preset('a', { sandboxed: false })] }
			expect(applySandboxSettings(config)[0].sandboxed).toBe(false)
		})

		it('keeps an explicit preset opt-in over a disabled top-level config', () => {
			const config: RojConfig = { sandboxed: false, presets: [preset('a', { sandboxed: true })] }
			expect(applySandboxSettings(config)[0].sandboxed).toBe(true)
		})

		it('defaults to off when neither level declares anything', () => {
			expect(applySandboxSettings({ presets: [preset('a')] })[0].sandboxed).toBe(false)
		})

		it('resolves each preset independently', () => {
			const config: RojConfig = {
				sandboxed: true,
				presets: [preset('a'), preset('b', { sandboxed: false })],
			}
			expect(applySandboxSettings(config).map(p => p.sandboxed)).toEqual([true, false])
		})

		it('leaves the input presets untouched', () => {
			const original = preset('a')
			applySandboxSettings({ sandboxed: true, presets: [original] })
			expect(original.sandboxed).toBeUndefined()
		})
	})

	describe('extraBinds precedence', () => {
		it('applies the top-level binds to a shell plugin that declares none', () => {
			const config: RojConfig = {
				extraBinds: [bind],
				presets: [preset('a', { plugins: [shellPlugin.configure({ cwd: '/tmp' })] })],
			}
			expect(pluginConfigOf(applySandboxSettings(config)[0])).toEqual({ cwd: '/tmp', extraBinds: [bind] })
		})

		it('keeps the binds the shell plugin declares itself', () => {
			const config: RojConfig = {
				extraBinds: [bind],
				presets: [preset('a', { plugins: [shellPlugin.configure({ cwd: '/tmp', extraBinds: [presetBind] })] })],
			}
			expect(pluginConfigOf(applySandboxSettings(config)[0])).toEqual({ cwd: '/tmp', extraBinds: [presetBind] })
		})

		it('treats an explicit empty preset list as a declaration and keeps it', () => {
			const config: RojConfig = {
				extraBinds: [bind],
				presets: [preset('a', { plugins: [shellPlugin.configure({ cwd: '/tmp', extraBinds: [] })] })],
			}
			expect(pluginConfigOf(applySandboxSettings(config)[0])).toEqual({ cwd: '/tmp', extraBinds: [] })
		})

		it('leaves other plugins alone', () => {
			const config: RojConfig = {
				extraBinds: [bind],
				presets: [preset('a', { plugins: [filesystemPlugin.configure({}), shellPlugin.configure({ cwd: '/tmp' })] })],
			}
			const result = applySandboxSettings(config)[0]
			expect(pluginConfigOf(result, 0)).toEqual({})
			expect(pluginConfigOf(result, 1)).toEqual({ cwd: '/tmp', extraBinds: [bind] })
		})

		it('is a no-op when the config declares no binds', () => {
			const plugins = [shellPlugin.configure({ cwd: '/tmp' })]
			const result = applySandboxSettings({ presets: [preset('a', { plugins })] })[0]
			expect(result.plugins).toBe(plugins)
		})

		it('is a no-op for a preset that configures no plugins', () => {
			const result = applySandboxSettings({ extraBinds: [bind], presets: [preset('a')] })[0]
			expect(result.plugins).toBeUndefined()
		})
	})
})

describe('describeSandboxPosture', () => {
	it('reports on when every preset is sandboxed', () => {
		expect(describeSandboxPosture([preset('a', { sandboxed: true })])).toBe('on')
	})

	it('reports off when no preset is sandboxed', () => {
		expect(describeSandboxPosture([preset('a', { sandboxed: false })])).toBe('off')
	})

	it('names both sides when presets disagree', () => {
		const presets = [preset('a', { sandboxed: true }), preset('b', { sandboxed: false })]
		expect(describeSandboxPosture(presets)).toBe('on for a; off for b')
	})
})
