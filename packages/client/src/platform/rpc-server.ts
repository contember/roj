/**
 * Type-safe RPC server handler.
 * Maps method names to handler functions, dispatches incoming requests.
 *
 * Usage:
 *   const router = createRpcRouter(platformMethods, {
 *     'instances.create': async (input, ctx) => { ... },
 *     'instances.get': async (input, ctx) => { ... },
 *   })
 *   // In Hono route:
 *   app.post('/rpc', (c) => router.handle(c.req.json(), ctx))
 */
import type { MethodDef, MethodInput, MethodOutput, RpcError, RpcRequest, RpcResponse } from './rpc-definition.js'

export type MethodHandler<
	Methods extends Record<string, MethodDef>,
	M extends keyof Methods,
	Ctx,
> = (input: MethodInput<Methods, M>, ctx: Ctx) => Promise<MethodOutput<Methods, M>>

export type MethodHandlers<
	Methods extends Record<string, MethodDef>,
	Ctx,
> = {
	[M in keyof Methods]: MethodHandler<Methods, M, Ctx>
}

export interface RpcRouter<Ctx> {
	handle(request: RpcRequest, ctx: Ctx): Promise<RpcResponse>
}

export function createRpcRouter<
	Methods extends Record<string, MethodDef>,
	Ctx,
>(
	_methods: Methods,
	handlers: MethodHandlers<Methods, Ctx>,
): RpcRouter<Ctx> {
	return {
		async handle(request: RpcRequest, ctx: Ctx): Promise<RpcResponse> {
			const handler = handlers[request.method as keyof Methods]
			if (!handler) {
				return {
					ok: false,
					error: { type: 'method_not_found', message: `Unknown method: ${request.method}` },
				}
			}

			try {
				const result = await handler(request.input as any, ctx)
				return { ok: true, value: result }
			} catch (error) {
				const rpcError: RpcError = error instanceof Error
					? { type: 'handler_error', message: error.message }
					: { type: 'unknown_error', message: String(error) }
				return { ok: false, error: rpcError }
			}
		},
	}
}
