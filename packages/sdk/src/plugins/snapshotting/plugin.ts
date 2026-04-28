/**
 * Snapshotting Plugin — takes JJ snapshots after tool execution
 *
 * Wraps the Snapshotter interface into a plugin with afterToolCall hook.
 * The actual snapshotting implementation (JjSnapshotter) is injected via plugin config.
 */

import { definePlugin } from '~/core/plugins/plugin-builder.js'
import type { Snapshotter } from './snapshotter.js'

/**
 * Plugin config — provides a pre-configured Snapshotter instance.
 */
export interface SnapshottingPluginConfig {
	snapshotter: Snapshotter
}

export const snapshottingPlugin = definePlugin('snapshotting')
	.pluginConfig<SnapshottingPluginConfig>()
	.sessionHook('onSessionReady', async (ctx) => {
		await ctx.pluginConfig.snapshotter.init()
	})
	.hook('afterToolCall', async (ctx) => {
		const snapshotter = ctx.pluginConfig.snapshotter
		try {
			await snapshotter.snapshot()
		} catch (error) {
			ctx.logger.warn('Snapshotting failed after tool call', {
				agentId: ctx.agentId,
				toolName: ctx.toolCall.name,
				error: error instanceof Error ? error.message : String(error),
			})
		}
		return null
	})
	.build()
