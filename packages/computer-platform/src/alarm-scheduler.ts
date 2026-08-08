/**
 * Scheduler over a Durable Object's single alarm slot.
 *
 * A DO has no process between wakes, so it implements the plain {@link Scheduler}
 * port rather than `LiveScheduler`: the host delivers through {@link AlarmScheduler.deliverDue}
 * from its own `alarm()` handler, in whichever isolate happens to be alive by then.
 *
 * Two shapes of the SDK dictate the design. It arms without awaiting —
 * `scheduleProcessing()` and `shutdown()` are synchronous, so the promises are
 * dropped — and it cancels a key then re-arms it in the same frame. So the state
 * that decides what is due (an in-memory key→dueAt map and its row in the DO's
 * synchronous KV) moves synchronously, where nothing can reorder it; the alarm
 * slot, which is asynchronous storage I/O, is reconciled afterwards against the
 * map as it stands when the write runs — never against the arguments that queued it.
 */

import type { Scheduler, WakeHandler } from '@roj-ai/sdk/platform'

/** Synchronous key-value surface of a SQLite-backed Durable Object (`storage.kv`). */
export interface SyncKvLike {
	list<T = unknown>(options?: { prefix?: string }): Iterable<[string, T]>
	put<T>(key: string, value: T): void
	delete(key: string): boolean
}

/** The parts of `DurableObjectStorage` a wake needs: one alarm, and rows to survive in. */
export interface AlarmStorageLike {
	kv: SyncKvLike
	setAlarm(scheduledTime: number): Promise<void>
	deleteAlarm(): Promise<void>
	/** Optional so a test double need not implement it; see {@link applyAlarm}. */
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
}

export interface AlarmSchedulerStats {
	/** Wakes armed and not yet delivered. */
	pending: number
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
	/** Settle the pending alarm writes. Call before an entry point returns. */
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
const KEY_PREFIX = 'roj:wake:'

/**
 * Clock slack when draining. workerd pins `Date.now()` between I/O, so an alarm
 * can read as fractionally early; without slack that costs an extra round trip.
 */
const DRAIN_SLACK_MS = 10

export function createAlarmScheduler(host: AlarmSchedulerHost): AlarmScheduler {
	const storage = host.storage
	const track = host.waitUntil?.bind(host)
	const dueAt = new Map<string, number>()
	let armedAt: number | undefined
	let tail: Promise<void> = Promise.resolve()
	let suspended = 0
	let drains = 0
	let delivered = 0

	// Wakes outlive the isolate that armed them, so a fresh one starts from the rows.
	for (const [key, value] of storage.kv.list<number>({ prefix: KEY_PREFIX })) {
		if (typeof value === 'number') dueAt.set(key.slice(KEY_PREFIX.length), value)
	}

	const earliest = (): number | undefined => {
		let min: number | undefined
		for (const at of dueAt.values()) {
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
	if (dueAt.size > 0) void reconcile().catch(() => undefined)

	return {
		async wake(key: string, delayMs: number): Promise<void> {
			if (suspended > 0) return
			const at = Date.now() + Math.max(delayMs, 0)
			// Synchronous, so the cancel-then-arm pair the SDK issues in one frame
			// cannot land out of order however long the alarm write takes.
			dueAt.set(key, at)
			storage.kv.put(KEY_PREFIX + key, at)
			await reconcile()
		},

		async cancel(key: string): Promise<void> {
			if (suspended > 0) return
			// The map mirrors the rows, so a key it does not hold has no row either.
			if (!dueAt.delete(key)) return
			storage.kv.delete(KEY_PREFIX + key)
			await reconcile()
		},

		async deliverDue(deliver: WakeHandler): Promise<string[]> {
			// workerd clears the slot before delivering, so this isolate holds nothing.
			armedAt = undefined
			drains += 1

			const cutoff = Date.now() + DRAIN_SLACK_MS
			const due: string[] = []
			for (const [key, at] of dueAt) {
				if (at <= cutoff) due.push(key)
			}
			for (const key of due) {
				dueAt.delete(key)
				storage.kv.delete(KEY_PREFIX + key)
			}

			// Re-arm before dispatching: a wake that runs long, or throws, must not
			// strand the ones behind it.
			await reconcile()

			for (const key of due) {
				delivered += 1
				try {
					await deliver(key)
				} catch {
					// The handler owns its own error reporting; the drain must still finish.
				}
			}
			return due
		},

		async flush(): Promise<void> {
			// Deliveries and agent work chain further reconciles as they run.
			let seen: Promise<void> | undefined
			while (seen !== tail) {
				seen = tail
				await seen
			}
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
			return { pending: dueAt.size, armedAt: armedAt ?? null, drains, delivered }
		},
	}
}
