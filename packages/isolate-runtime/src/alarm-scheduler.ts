/**
 * Scheduler over a Durable Object's single alarm slot.
 *
 * A DO has no process between wakes, so it implements the plain {@link Scheduler}
 * port rather than `LiveScheduler`: the host delivers through {@link AlarmScheduler.deliverDue}
 * from its own `alarm()` handler, in whichever isolate happens to be alive by then.
 * The slot is reached through {@link AlarmStorageLike}, so a DO facet, which has no
 * alarm of its own, can borrow its parent's.
 *
 * Two shapes of the SDK dictate the design. It arms without awaiting —
 * `scheduleProcessing()` and `shutdown()` are synchronous, so the promises are
 * dropped — and it cancels a key then re-arms it in the same frame. So the state
 * that decides what is due (in-memory key→dueAt maps and their rows in the DO's
 * synchronous KV) moves synchronously, where nothing can reorder it; the alarm
 * slot, which is asynchronous storage I/O, is reconciled afterwards against the
 * maps as they stand when the write runs — never against the arguments that queued it.
 */

import type { Scheduler, WakeHandler } from '@roj-ai/sdk/platform'

/** Synchronous key-value surface of a SQLite-backed Durable Object (`storage.kv`). */
export interface SyncKvLike {
	list(options?: { prefix?: string }): Iterable<[string, unknown]>
	put(key: string, value: unknown): void
	delete(key: string): boolean
}

/** The parts of `DurableObjectStorage` a wake needs: one alarm, and rows to survive in. */
export interface AlarmStorageLike {
	kv: SyncKvLike
	setAlarm(scheduledTime: number): Promise<void>
	deleteAlarm(): Promise<void>
	/** Optional so a test double need not implement it; see `applyAlarm`. */
	sync?(): Promise<void>
}

export interface AlarmSchedulerHost {
	storage: AlarmStorageLike
	/**
	 * Keeps a promise nobody awaits alive. `DurableObjectState.waitUntil` puts it
	 * on the actor's IoContext, so an arm issued during a request outlives the
	 * frame that issued it.
	 */
	waitUntil?(promise: Promise<unknown>): void
	/** How long after a delivery starts it is delivered again unless it finished. Default 5 minutes. */
	inFlightRetryMs?: number
}

export interface AlarmSchedulerStats {
	/** Wakes armed and not yet delivered. */
	pending: number
	/** Deliveries started and not finished, each with a retry armed. */
	inFlight: number
	/** What the alarm slot holds, as far as this isolate knows. */
	armedAt: number | null
	/** Alarms drained since this isolate booted. */
	drains: number
	/** Wakes handed to a delivery handler since this isolate booted. */
	delivered: number
}

export interface AlarmScheduler extends Scheduler {
	/**
	 * Drain every wake now due, re-arm for the next, then hand each drained key to
	 * `deliver`. Call from the DO's `alarm()`; returns the keys delivered.
	 */
	deliverDue(deliver: WakeHandler): Promise<string[]>
	/** Settle the pending alarm writes. Call before an entry point returns. Throws when the slot cannot be written. */
	flush(): Promise<void>
	/**
	 * Ignore wakes and cancels while `fn` runs.
	 *
	 * `SessionManager.shutdown()` cancels every agent's wakes — right when a
	 * session is being torn down, wrong when the isolate is merely going away,
	 * which drops exactly the wake this port exists to preserve. Only the host
	 * knows which of the two it is doing.
	 */
	suspend<T>(fn: () => Promise<T>): Promise<T>
	stats(): AlarmSchedulerStats
}

/** Namespaced so wakes cannot collide with whatever else the host keeps in storage. */
const WAKE_PREFIX = 'roj:wake:'
const RETRY_PREFIX = 'roj:retry:'

const DEFAULT_IN_FLIGHT_RETRY_MS = 5 * 60_000

/**
 * Clock slack when draining. workerd pins `Date.now()` between I/O, so an alarm
 * can read as fractionally early; without slack that costs an extra round trip.
 */
const DRAIN_SLACK_MS = 10

/** A key→time map mirrored into KV rows, so it outlives the isolate. */
function persistedTimes(kv: SyncKvLike, prefix: string) {
	const times = new Map<string, number>()
	for (const [key, value] of kv.list({ prefix })) {
		if (typeof value === 'number') times.set(key.slice(prefix.length), value)
	}
	return {
		times,
		set(key: string, at: number): void {
			times.set(key, at)
			kv.put(prefix + key, at)
		},
		delete(key: string): boolean {
			// The map mirrors the rows, so a key it does not hold has no row either.
			if (!times.delete(key)) return false
			kv.delete(prefix + key)
			return true
		},
		dueBy(cutoff: number): string[] {
			return [...times].filter(([, at]) => at <= cutoff).map(([key]) => key)
		},
	}
}

export function createAlarmScheduler(host: AlarmSchedulerHost): AlarmScheduler {
	const storage = host.storage
	const track = host.waitUntil?.bind(host)
	const inFlightRetryMs = host.inFlightRetryMs ?? DEFAULT_IN_FLIGHT_RETRY_MS
	const wakes = persistedTimes(storage.kv, WAKE_PREFIX)
	// A delivery lost to an eviction never reaches its end, and its wake row is already gone.
	// The retry row brings the alarm back, so the session loads and recovers its agents.
	const retries = persistedTimes(storage.kv, RETRY_PREFIX)
	let armedAt: number | undefined
	let tail: Promise<void> = Promise.resolve()
	let suspended = 0
	let drains = 0
	let delivered = 0

	const earliest = (): number | undefined => {
		let min: number | undefined
		for (const at of [...wakes.times.values(), ...retries.times.values()]) {
			if (min === undefined || at < min) min = at
		}
		return min
	}

	const applyAlarm = async (): Promise<void> => {
		const target = earliest()
		if (target === armedAt) return
		if (target === undefined) await storage.deleteAlarm()
		else await storage.setAlarm(target)
		armedAt = target
		// Awaiting the write only queues it; sync() is what waits for it to be durable,
		// and an isolate aborted before that point loses the arm.
		await storage.sync?.()
	}

	/** Queue one alarm write. Serialized, because there is only one slot to race over. */
	const reconcile = (): Promise<void> => {
		const next = tail.then(applyAlarm)
		// The tail must never reject, or every later reconcile inherits this failure.
		const settled = next.catch(() => undefined)
		tail = settled
		track?.(settled)
		return next
	}

	// A previous isolate may have died between writing rows and committing its alarm.
	if (wakes.times.size > 0 || retries.times.size > 0) void reconcile().catch(() => undefined)

	return {
		async wake(key: string, delayMs: number): Promise<void> {
			if (suspended > 0) return
			// Synchronous, so the cancel-then-arm pair the SDK issues in one frame
			// cannot land out of order however long the alarm write takes.
			wakes.set(key, Date.now() + Math.max(delayMs, 0))
			await reconcile()
		},

		async cancel(key: string): Promise<void> {
			if (suspended > 0) return
			if (!wakes.delete(key)) return
			await reconcile()
		},

		async deliverDue(deliver: WakeHandler): Promise<string[]> {
			// workerd clears the slot before delivering, so this isolate holds nothing.
			armedAt = undefined
			drains += 1

			const cutoff = Date.now() + DRAIN_SLACK_MS
			const due = [...new Set([...wakes.dueBy(cutoff), ...retries.dueBy(cutoff)])]
			const retryAt = Date.now() + inFlightRetryMs
			for (const key of due) {
				wakes.delete(key)
				retries.set(key, retryAt)
			}

			// Re-arm before dispatching: a wake that runs long, or throws, must not
			// strand the ones behind it.
			await reconcile()

			// Concurrently: one wake runs a whole agent turn, and the slot fires one alarm at a time.
			await Promise.all(due.map(async key => {
				delivered += 1
				try {
					await deliver(key)
					retries.delete(key)
				} catch {
					// The handler owns its error reporting. The retry row stays, so the wake is delivered again.
				}
			}))
			if (due.length > 0) await reconcile()
			return due
		},

		async flush(): Promise<void> {
			// Deliveries and agent work chain further reconciles as they run.
			let seen: Promise<void> | undefined
			while (seen !== tail) {
				seen = tail
				await seen
			}
			// A failed write leaves rows the slot does not cover. Try once more, and let a second failure surface.
			if (earliest() !== armedAt) await reconcile()
		},

		async suspend<T>(fn: () => Promise<T>): Promise<T> {
			suspended += 1
			try {
				return await fn()
			} finally {
				suspended -= 1
			}
		},

		stats(): AlarmSchedulerStats {
			return { pending: wakes.times.size, inFlight: retries.times.size, armedAt: armedAt ?? null, drains, delivered }
		},
	}
}
