/**
 * Composed event reducer — core reducer + plugin state slices.
 *
 * This file is the composition root for the event-sourced reducer.
 * Core SessionState stays free of plugin imports; each plugin owns a
 * dynamic state slice accessed via `selectPluginState()`.
 *
 * The default `applyEvent` includes core + always-enabled plugins (mailbox).
 * Additional plugin reducers are composed via `createApplyEvent()`.
 */

import type { ConfiguredPlugin } from '~/core/plugins/plugin-builder.js'
import { mailboxPlugin } from '~/plugins/mailbox/plugin.js'
import type { SessionReducer } from './reducer.js'
import { composeReducers } from './reducer.js'
import { coreReducer } from './state.js'

/**
 * Base reducer: core events + always-enabled plugin state slices (mailbox).
 * Mailbox is always enabled, has no config, and is fundamental to all sessions.
 */
const mailboxConfigured = mailboxPlugin.create({})
const baseReducer: SessionReducer = mailboxConfigured.slice
	? composeReducers(coreReducer, mailboxConfigured.slice.reducer)
	: coreReducer

export const applyEvent: SessionReducer = baseReducer

/**
 * Create a composed reducer that handles core + all plugin events.
 * Use this when additional plugins are available (e.g. in SessionStore).
 */
export const createApplyEvent = (plugins: ConfiguredPlugin[]): SessionReducer => {
	const pluginReducers: SessionReducer[] = []
	for (const plugin of plugins) {
		// Skip mailbox — already included in baseReducer
		if (plugin.name === 'mailbox') continue
		if (plugin.slice !== undefined) {
			pluginReducers.push(plugin.slice.reducer)
		}
	}

	if (pluginReducers.length === 0) return baseReducer

	return composeReducers(baseReducer, ...pluginReducers)
}
