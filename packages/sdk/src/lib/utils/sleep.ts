/**
 * Cancellable sleep.
 *
 * Resolves early (rather than rejecting) when `signal` aborts, so a retry or
 * poll loop can check its own abort condition and exit on the next iteration.
 * Prefer this over a bare `setTimeout` promise anywhere inside such a loop —
 * a non-cancellable wait is what makes shutdown take as long as the backoff.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.resolve()
	return new Promise<void>((resolve) => {
		let settled = false
		const finish = () => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			signal?.removeEventListener('abort', finish)
			resolve()
		}
		const timer = setTimeout(finish, ms)
		signal?.addEventListener('abort', finish, { once: true })
	})
}
