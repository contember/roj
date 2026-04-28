#!/usr/bin/env bun
/**
 * Demo launcher — starts @roj-ai/standalone-server with the App Builder preset.
 *
 * Runs alongside vite: SPA dev server on :2487 proxies /api and /ws to this
 * API server on :2486. The standalone server is a single Bun process hosting
 * the agent + a platform-compatible REST+WS surface on /api/v1/*.
 */

import { startStandaloneServer } from '@roj-ai/standalone-server'
import { appBuilderPreset } from './agent/preset'

const port = Number(process.env.PORT) || 2486

await startStandaloneServer({
	presets: [appBuilderPreset],
	config: { port },
})
