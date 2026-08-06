/**
 * Run an async mapping with bounded concurrency.
 *
 * Spawns up to `concurrency` workers that pull from a shared cursor.
 * Results preserve input order.
 */
export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	concurrency: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length)
	let next = 0
	const workerCount = Math.max(1, Math.min(concurrency, items.length))
	const workers = Array.from({ length: workerCount }, async () => {
		while (true) {
			const i = next++
			if (i >= items.length) return
			results[i] = await fn(items[i] as T, i)
		}
	})
	await Promise.all(workers)
	return results
}

/**
 * Counting semaphore with FIFO waiter queue.
 *
 * Use `run(fn)` to execute work under the gate — acquires before invoking,
 * releases on resolve/reject. Suitable for bounding contention on a shared
 * resource (e.g. concurrent LLM calls) regardless of how many call sites
 * compete for it.
 */
export class Semaphore {
	private active = 0
	private readonly waiters: Array<{
		resolve: () => void
		signal?: AbortSignal
		onAbort?: () => void
	}> = []

	constructor(private readonly limit: number) {
		if (!Number.isInteger(limit) || limit < 1) {
			throw new Error(`Semaphore limit must be a positive integer, got ${limit}`)
		}
	}

	async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		let acquired = false
		try {
			await this.acquire(signal)
			acquired = true
			signal?.throwIfAborted()
			return await fn()
		} finally {
			if (acquired) this.release()
		}
	}

	private acquire(signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) {
			return Promise.reject(signal.reason)
		}
		if (this.active < this.limit) {
			this.active++
			return Promise.resolve()
		}
		return new Promise<void>((resolve, reject) => {
			const waiter: {
				resolve: () => void
				signal?: AbortSignal
				onAbort?: () => void
			} = { resolve, signal }
			if (signal) {
				const onAbort = () => {
					const index = this.waiters.indexOf(waiter)
					if (index === -1) return
					this.waiters.splice(index, 1)
					signal.removeEventListener('abort', onAbort)
					reject(signal.reason)
				}
				waiter.onAbort = onAbort
				signal.addEventListener('abort', onAbort, { once: true })
			}
			this.waiters.push(waiter)
		})
	}

	private release(): void {
		const next = this.waiters.shift()
		if (next) {
			// Slot transfers directly to the next waiter; active stays unchanged.
			if (next.signal && next.onAbort) {
				next.signal.removeEventListener('abort', next.onAbort)
			}
			next.resolve()
		} else {
			this.active--
		}
	}
}
