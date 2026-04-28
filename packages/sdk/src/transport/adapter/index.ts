/**
 * Transport Adapter Module
 *
 * Simplified for broadcast-only WebSocket communication.
 * User messages and answers are handled via REST API.
 */

export type { IAgentTransport, PluginNotification } from './types.js'

export { ServerAdapter } from './server-adapter.js'
export type { ServerAdapterConfig } from './server-adapter.js'

export { ClientAdapter } from './client-adapter.js'
export type { ClientAdapterConfig } from './client-adapter.js'

// ============================================================================
// Factory
// ============================================================================

import { ClientAdapter, type ClientAdapterConfig } from './client-adapter.js'
import { ServerAdapter, type ServerAdapterConfig } from './server-adapter.js'
import type { IAgentTransport } from './types.js'

export interface StandaloneConfig extends ServerAdapterConfig {
	mode: 'standalone'
}

export interface WorkerConfig extends ClientAdapterConfig {
	mode: 'worker'
}

export type AgentTransportConfig = StandaloneConfig | WorkerConfig

export function createAgentTransport(config: AgentTransportConfig): IAgentTransport {
	if (config.mode === 'standalone') {
		const { mode: _mode, ...rest } = config
		return new ServerAdapter(rest)
	} else {
		const { mode: _mode, ...rest } = config
		return new ClientAdapter(rest)
	}
}
