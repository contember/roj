/**
 * Scheduler adapter interface.
 *
 * The agent loop re-enters through this port instead of a bare `setTimeout`, so
 * a host with no live process between wakes can drive it — on Cloudflare,
 * `ctx.storage.setAlarm()` then `alarm()`.
 */

/** Called when a wake armed for `key` comes due. */
export type WakeHandler = (key: string) => void | Promise<void>

export interface Scheduler {
	/** Wake `key` after `delayMs`. Replaces any pending wake for the same key. */
	wake(key: string, delayMs: number): Promise<void>
	cancel(key: string): Promise<void>
}

/**
 * A scheduler that delivers its own wakes, because the process that armed them
 * is still alive. Hosts that deliver out-of-band implement plain {@link Scheduler}
 * and call `SessionManager.dispatchWake` from their own handler.
 */
export interface LiveScheduler extends Scheduler {
	/** Register where due wakes are delivered. Replaces any previous handler. */
	onWake(handler: WakeHandler): void
}

export function isLiveScheduler(scheduler: Scheduler): scheduler is LiveScheduler {
	return 'onWake' in scheduler && typeof scheduler.onWake === 'function'
}

/**
 * `setTimeout`-backed scheduler for hosts with a live process.
 *
 * Arms and clears synchronously, so the cancel-then-wake sequence callers issue
 * without awaiting cannot land out of order.
 */
export function createTimerScheduler(): LiveScheduler {
	const timers = new Map<string, ReturnType<typeof setTimeout>>()
	let handler: WakeHandler | undefined

	const clear = (key: string): void => {
		const timer = timers.get(key)
		if (timer === undefined) return
		clearTimeout(timer)
		timers.delete(key)
	}

	return {
		onWake(next: WakeHandler): void {
			handler = next
		},

		async wake(key: string, delayMs: number): Promise<void> {
			clear(key)
			timers.set(
				key,
				setTimeout(() => {
					timers.delete(key)
					const dispatched = handler?.(key)
					// The handler owns its own error reporting; there is nothing a timer can do.
					if (dispatched) void dispatched.catch(() => {})
				}, delayMs),
			)
		},

		async cancel(key: string): Promise<void> {
			clear(key)
		},
	}
}
