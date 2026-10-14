/**
 * A minimal host for the e2e test: one instance Durable Object that loads the runtime and an app
 * bundle through the Worker Loader and runs them as a facet. It shows what a platform has to provide:
 * caller stamping, the alarm proxy, the `RuntimeHost` entrypoint and an egress gateway.
 *
 *   PUT  /policy   system only: allowed origins and the headers the gateway adds per origin
 *   POST /rpc      { method, input }, forwarded with `_caller` set from the authenticated principal
 *   GET  /status   the runtime's /status
 *   GET  /host     what the host saw: alarm deliveries and broadcasts
 *   POST /evict    abort the facet, keeping its storage, as an eviction would
 *
 * The `x-e2e-principal: system` header stands in for API-key authentication.
 */

import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers'
import type { RuntimeBroadcast, RuntimeFacetRpc, RuntimeHost as RuntimeHostContract } from '../src/host-contract'
import runtime from './.generated/modules.json'

interface Env {
	INSTANCE: DurableObjectNamespace<InstanceDO>
	LOADER: WorkerLoader
}

type InstanceProps = { instance: string }
type AddedHeader = { origin: string; header: string; value: string }
type EgressPolicy = { allowedOrigins: string[]; headers: AddedHeader[] }

const PROVIDER_ORIGIN = 'https://openrouter.ai'

function instanceStub(env: Env, instance: string) {
	return env.INSTANCE.get(env.INSTANCE.idFromName(instance))
}

export class InstanceDO extends DurableObject<Env> {
	#alarmDeliveries = 0
	readonly #broadcasts: string[] = []

	#runtime() {
		const instance = this.ctx.id.name ?? this.ctx.id.toString()
		// The loader requires identical code for one id; a platform derives it from the bundle and runtime versions.
		const worker = this.env.LOADER.get('e2e-runtime', () => ({
			compatibilityDate: '2026-09-25',
			compatibilityFlags: ['nodejs_compat'],
			mainModule: runtime.mainModule,
			modules: runtime.modules,
			env: { HOST: this.ctx.exports.RuntimeHost({ props: { instance } }) },
			globalOutbound: this.ctx.exports.EgressGateway({ props: { instance } }),
		}))
		return this.ctx.facets.get('runtime', () => ({ class: worker.getDurableObjectClass<DurableObject & RuntimeFacetRpc>('Runtime') }))
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url)
		const principal = request.headers.get('x-e2e-principal') === 'system' ? 'system' : 'client'
		const route = `${request.method} ${url.pathname}`
		if (route === 'PUT /policy') {
			if (principal !== 'system') return Response.json({ error: 'SYSTEM_ONLY' }, { status: 403 })
			this.ctx.storage.kv.put('egress-policy', await request.json())
			return Response.json({ ok: true })
		}
		if (route === 'POST /rpc') {
			const body: { method: string; input: Record<string, unknown> } = await request.json()
			// Whatever `_caller` the client sent is replaced by the principal this host authenticated.
			const input = { ...body.input, _caller: { source: principal, meta: {} } }
			return this.#runtime().fetch(new Request('http://runtime/rpc', { method: 'POST', body: JSON.stringify({ method: body.method, input }) }))
		}
		if (route === 'GET /status') return this.#runtime().fetch(new Request('http://runtime/status'))
		if (route === 'GET /host') {
			return Response.json({ alarm: await this.ctx.storage.getAlarm(), alarmDeliveries: this.#alarmDeliveries, broadcasts: this.#broadcasts })
		}
		if (route === 'POST /evict') {
			this.ctx.facets.abort('runtime', new Error('e2e eviction'))
			return Response.json({ ok: true })
		}
		return new Response('not found', { status: 404 })
	}

	/** Facets have no alarm of their own: the host owns the slot and delivers the wakes. */
	async alarm(): Promise<void> {
		this.#alarmDeliveries += 1
		await this.#runtime().deliverWakes()
	}

	async setFacetAlarm(scheduledTime: number) {
		await this.ctx.storage.setAlarm(scheduledTime)
	}

	async deleteFacetAlarm() {
		await this.ctx.storage.deleteAlarm()
	}

	recordBroadcast(message: RuntimeBroadcast) {
		this.#broadcasts.push(message.type)
	}

	egressPolicy(): EgressPolicy {
		return this.ctx.storage.kv.get<EgressPolicy>('egress-policy') ?? { allowedOrigins: [], headers: [] }
	}
}

/** `env.HOST` of the facet. The props name the instance; the loaded code can neither read nor change them. */
export class RuntimeHost extends WorkerEntrypoint<Env, InstanceProps> implements RuntimeHostContract {
	setAlarm(scheduledTime: number) {
		return instanceStub(this.env, this.ctx.props.instance).setFacetAlarm(scheduledTime)
	}

	deleteAlarm() {
		return instanceStub(this.env, this.ctx.props.instance).deleteFacetAlarm()
	}

	async broadcast(message: RuntimeBroadcast) {
		await instanceStub(this.env, this.ctx.props.instance).recordBroadcast(message)
	}
}

/** The facet's `globalOutbound`: every `fetch` the runtime or the app makes lands here. */
export class EgressGateway extends WorkerEntrypoint<Env, InstanceProps> {
	async fetch(request: Request): Promise<Response> {
		const policy = await instanceStub(this.env, this.ctx.props.instance).egressPolicy()
		const origin = new URL(request.url).origin
		if (!policy.allowedOrigins.includes(origin)) return new Response(`EGRESS_FORBIDDEN ${origin}`, { status: 403 })
		const headers = new Headers(request.headers)
		for (const added of policy.headers) {
			if (added.origin === origin) headers.set(added.header, added.value)
		}
		// Manual: a followed redirect would carry the added headers to an origin nobody checked.
		const outgoing = new Request(request.url, { method: request.method, headers, body: request.body, redirect: 'manual' })
		return origin === PROVIDER_ORIGIN ? fakeProvider(outgoing, policy) : fetch(outgoing)
	}
}

/** Answers like OpenRouter, but only to the key the gateway added — so the test sees the injection work. */
function fakeProvider(request: Request, policy: EgressPolicy): Response {
	const expected = policy.headers.find(added => added.origin === PROVIDER_ORIGIN && added.header === 'authorization')
	if (!expected || request.headers.get('authorization') !== expected.value) {
		return Response.json({ error: { message: 'invalid key' } }, { status: 401 })
	}
	return Response.json({
		id: 'e2e',
		model: 'test/model',
		choices: [{ message: { content: 'Hello.' }, finish_reason: 'stop' }],
		usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
	})
}

export default {
	fetch(request: Request, env: Env) {
		return instanceStub(env, 'e2e-instance').fetch(request)
	},
}
