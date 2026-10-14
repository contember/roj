/** In-memory stand-ins for the Durable Object storage the scheduler uses. Tests only. */

import type { AlarmStorageLike, SyncKvLike } from './alarm-scheduler.js'

export class MemoryKv implements SyncKvLike {
	readonly #rows = new Map<string, unknown>()

	list(options?: { prefix?: string }): Iterable<[string, unknown]> {
		const prefix = options?.prefix ?? ''
		return [...this.#rows].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b))
	}

	put(key: string, value: unknown): void {
		this.#rows.set(key, value)
	}

	delete(key: string): boolean {
		return this.#rows.delete(key)
	}
}

export class MemoryAlarmStorage implements AlarmStorageLike {
	readonly kv = new MemoryKv()
	alarm: number | null = null

	async setAlarm(scheduledTime: number): Promise<void> {
		this.alarm = scheduledTime
	}

	async deleteAlarm(): Promise<void> {
		this.alarm = null
	}
}
