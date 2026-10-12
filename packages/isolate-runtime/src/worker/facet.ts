import type { RojConfig } from '@roj-ai/sdk'
import { DurableObject } from 'cloudflare:workers'
import type { RuntimeFacetRpc, RuntimeHost } from '../host-contract.js'
import { createIsolateRuntime, type IsolateRuntime } from '../runtime.js'

export interface RuntimeFacetEnv {
	HOST: RuntimeHost
}

/** The Durable Object class a host gets through `getDurableObjectClass('Runtime')` and runs as a facet. */
export function createRuntimeFacet(userConfig: RojConfig) {
	return class Runtime extends DurableObject<RuntimeFacetEnv> implements RuntimeFacetRpc {
		readonly #runtime: IsolateRuntime

		constructor(ctx: DurableObjectState, env: RuntimeFacetEnv) {
			super(ctx, env)
			this.#runtime = createIsolateRuntime({ userConfig, host: env.HOST, state: ctx })
			void ctx.blockConcurrencyWhile(() => this.#runtime.start())
		}

		fetch(request: Request): Promise<Response> {
			return this.#runtime.fetch(request)
		}

		deliverWakes(): Promise<string[]> {
			return this.#runtime.deliverWakes()
		}
	}
}
