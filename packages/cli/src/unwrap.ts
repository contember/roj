import { RpcError } from '@roj-ai/shared/rpc'
import type { Result } from '@roj-ai/shared/rpc'
import type { RpcErrorInfo } from '@roj-ai/shared/rpc'

export function unwrap<T>(result: Result<T, RpcErrorInfo>): T {
	if (result.ok) return result.value
	throw new RpcError(0, result.error)
}
