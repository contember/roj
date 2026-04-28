/**
 * Test-only bootstrap helper: wires memory persistence, mock LLM, and a
 * node-backed Platform so integration tests don't need a runtime package.
 *
 * Production callers should use `bootstrap()` directly and pass a Platform
 * from their runtime package (e.g. `@roj-ai/sdk/bun-platform`).
 */

import { bootstrap, type Services } from '~/bootstrap.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import type { MockInferenceHandler } from '~/core/llm/mock.js'
import type { Preset } from '~/core/preset/index.js'
import { createNodePlatform } from './node-platform.js'

export function bootstrapForTesting(
	mockHandler?: MockInferenceHandler,
	presets?: Preset[],
): Services {
	const defaultHandler: MockInferenceHandler = () => ({
		content: 'Mock response',
		toolCalls: [],
		finishReason: 'stop',
		metrics: MockLLMProvider.defaultMetrics(),
	})

	return bootstrap(
		{
			port: 0,
			host: 'localhost',
			dataPath: '',
			persistence: 'memory',
			logLevel: 'error',
			logFormat: 'console',
			llmMock: mockHandler ?? defaultHandler,
		},
		{ presets: presets ?? [] },
		createNodePlatform(),
	)
}
