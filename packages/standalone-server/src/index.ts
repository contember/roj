/**
 * @roj-ai/standalone-server — run a single roj instance on your machine.
 *
 * Exposes the same REST + WebSocket URL shape as the Cloudflare-hosted
 * platform (the subset that makes sense for a local single-instance setup),
 * so the same client SDK and React hooks work unchanged.
 */

export { startStandaloneServer } from './server.js'
export type { StartStandaloneOptions, StandaloneHandle } from './server.js'
export type { InstanceState } from './instance.js'
