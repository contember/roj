import type { RpcError } from './rpc-definition.js'

export class RojApiError extends Error {
	public readonly type: string

	constructor(public readonly error: RpcError) {
		super(error.message)
		this.name = 'RojApiError'
		this.type = error.type
	}
}
