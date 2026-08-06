export type ProviderRequestAbortCause = 'caller' | 'timeout'

export class ProviderRequestAbortError extends Error {
	constructor(readonly abortCause: ProviderRequestAbortCause) {
		super(abortCause === 'caller' ? 'Request was aborted' : 'Request timed out')
		this.name = 'ProviderRequestAbortError'
	}
}

export async function runProviderRequest<T>(
	options: { callerSignal?: AbortSignal; timeoutMs: number },
	run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	if (options.callerSignal?.aborted) throw new ProviderRequestAbortError('caller')

	const controller = new AbortController()
	let abortCause: ProviderRequestAbortCause | undefined
	const abort = (cause: ProviderRequestAbortCause) => {
		if (abortCause) return
		abortCause = cause
		controller.abort()
	}
	const abortFromCaller = () => abort('caller')
	const timeoutId = setTimeout(() => abort('timeout'), options.timeoutMs)
	options.callerSignal?.addEventListener('abort', abortFromCaller, {
		once: true,
	})

	try {
		const response = await run(controller.signal)
		if (abortCause) throw new ProviderRequestAbortError(abortCause)
		return response
	} catch (error) {
		if (abortCause) throw new ProviderRequestAbortError(abortCause)
		throw error
	} finally {
		clearTimeout(timeoutId)
		options.callerSignal?.removeEventListener('abort', abortFromCaller)
	}
}
