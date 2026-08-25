export type RuntimeLeaseRelease = () => void

export interface SessionRuntimeActivitySnapshot {
	state: 'ready' | 'unloading' | 'disposed'
	activeCount: number
	reasons: Readonly<Record<string, number>>
	lastActivityAt: number
}

/** Session-scoped guard that keeps a resident runtime alive while work is active. */
export interface SessionRuntimeActivity {
	/**
	 * Take a lease, or throw when the runtime is no longer `ready`.
	 *
	 * Release it in a `finally` — an unreleased lease pins the runtime resident
	 * forever. Prefer `tryAcquire` wherever losing the race is a normal outcome.
	 */
	acquire(reason: string): RuntimeLeaseRelease
	/** Take a lease, or return null when the runtime is no longer `ready`. */
	tryAcquire(reason: string): RuntimeLeaseRelease | null
	getSnapshot(): SessionRuntimeActivitySnapshot
}

export class SessionRuntimeActivityController implements SessionRuntimeActivity {
	private state: SessionRuntimeActivitySnapshot['state'] = 'ready'
	private activeCount = 0
	private readonly reasons = new Map<string, number>()
	private lastActivityAt = performance.now()

	acquire(reason: string): RuntimeLeaseRelease {
		const release = this.tryAcquire(reason)
		if (!release) {
			throw new Error(`Session runtime is ${this.state}`)
		}
		return release
	}

	tryAcquire(reason: string): RuntimeLeaseRelease | null {
		if (this.state !== 'ready') return null

		this.lastActivityAt = performance.now()
		this.activeCount++
		this.reasons.set(reason, (this.reasons.get(reason) ?? 0) + 1)
		let released = false
		return () => {
			if (released) return
			released = true
			this.lastActivityAt = performance.now()
			this.activeCount--
			const count = this.reasons.get(reason) ?? 0
			if (count <= 1) this.reasons.delete(reason)
			else this.reasons.set(reason, count - 1)
		}
	}

	tryBeginUnload(): boolean {
		if (this.state !== 'ready' || this.activeCount !== 0) return false
		this.state = 'unloading'
		return true
	}

	beginForcedUnload(): void {
		if (this.state === 'ready') this.state = 'unloading'
	}

	markDisposed(): void {
		this.state = 'disposed'
	}

	getSnapshot(): SessionRuntimeActivitySnapshot {
		return {
			state: this.state,
			activeCount: this.activeCount,
			reasons: Object.fromEntries(this.reasons),
			lastActivityAt: this.lastActivityAt,
		}
	}
}
