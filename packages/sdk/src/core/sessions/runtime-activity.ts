import { SessionId } from './schema.js'

export type RuntimeLeaseRelease = () => void
export type SessionRuntimeState = 'ready' | 'parking' | 'unloading' | 'revoked' | 'disposed'

export class SessionRuntimeUnavailableError extends Error {
	constructor(readonly sessionId: SessionId, readonly state: SessionRuntimeState) {
		super(`Session runtime '${sessionId}' is ${state}`)
		this.name = 'SessionRuntimeUnavailableError'
	}
}

export interface RuntimeOperation {
	readonly activity: SessionRuntimeActivity
	release(): void
}

export interface SessionRuntimeActivitySnapshot {
	state: SessionRuntimeState
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
	tryOperation(reason: string): RuntimeOperation | null
	assertAvailable(): void
	trackResource<T>(run: () => Promise<T>): Promise<T>
}

export class SessionRuntimeActivityController implements SessionRuntimeActivity {
	private state: SessionRuntimeActivitySnapshot['state'] = 'ready'
	private activeCount = 0
	private readonly reasons = new Map<string, number>()
	private lastActivityAt = performance.now()
	private readonly idleWaiters = new Set<() => void>()
	private readonly revoked = Promise.withResolvers<never>()
	private readonly scopes = new WeakSet<SessionRuntimeActivity>()
	private pendingResources = 0

	hasPendingResources(): boolean {
		return this.pendingResources > 0
	}

	trackResource<T>(run: () => Promise<T>): Promise<T> {
		this.assertAvailable()
		return this.runResource(run)
	}

	private async runResource<T>(run: () => Promise<T>): Promise<T> {
		const operation = this.createOperation('resource')
		this.pendingResources++
		try { return await run() } finally { this.pendingResources--; operation.release() }
	}

	assertOwnScope(activity: SessionRuntimeActivity): void {
		if (activity !== this && !this.scopes.has(activity)) throw new SessionRuntimeUnavailableError(this.sessionId, this.state)
		activity.assertAvailable()
	}

	constructor(readonly sessionId: SessionId = SessionId('unknown')) {
		void this.revoked.promise.catch(() => {})
	}

	assertAvailable(): void {
		if (this.state !== 'ready') throw new SessionRuntimeUnavailableError(this.sessionId, this.state)
	}

	tryOperation(reason: string): RuntimeOperation | null {
		if (this.state !== 'ready') return null
		return this.createOperation(reason)
	}

	private createOperation(reason: string): RuntimeOperation {
		const releaseLease = this.takeLease(reason)
		let live = true
		const allowed = () => live && (this.state === 'ready' || this.state === 'parking' || this.state === 'unloading')
		const activity: SessionRuntimeActivity = {
			trackResource: (run) => {
				activity.assertAvailable()
				return this.runResource(run)
			},
			getSnapshot: () => this.getSnapshot(),
			assertAvailable: () => {
				if (!allowed()) throw new SessionRuntimeUnavailableError(this.sessionId, this.state)
			},
			tryOperation: (childReason) => allowed() ? this.createOperation(childReason) : null,
			tryAcquire: (childReason) => allowed() ? this.takeLease(childReason) : null,
			acquire: (childReason) => {
				activity.assertAvailable()
				return this.takeLease(childReason)
			},
		}
		this.scopes.add(activity)
		return {
			activity,
			release: () => {
				live = false
				releaseLease()
			},
		}
	}

	beginParking(): void {
		this.assertAvailable()
		this.state = 'parking'
	}

	beginTeardown(): RuntimeOperation {
		if (this.state !== 'parking') throw new SessionRuntimeUnavailableError(this.sessionId, this.state)
		return this.createOperation('teardown')
	}

	beginLegacyTeardown(): RuntimeOperation {
		if (this.state !== 'unloading') throw new SessionRuntimeUnavailableError(this.sessionId, this.state)
		return this.createOperation('teardown')
	}

	revoke(): void {
		this.state = 'revoked'
		this.revoked.reject(new SessionRuntimeUnavailableError(this.sessionId, this.state))
	}

	async waitForIdle(): Promise<void> {
		while (this.activeCount > 0) {
			const idle = Promise.withResolvers<void>()
			this.idleWaiters.add(idle.resolve)
			try {
				await this.untilRevoked(idle.promise)
			} finally {
				this.idleWaiters.delete(idle.resolve)
			}
		}
		if (this.state === 'revoked') throw new SessionRuntimeUnavailableError(this.sessionId, this.state)
	}

	untilRevoked<T>(work: Promise<T>): Promise<T> {
		return Promise.race([work, this.revoked.promise])
	}

	acquire(reason: string): RuntimeLeaseRelease {
		const release = this.tryAcquire(reason)
		if (!release) {
			throw new SessionRuntimeUnavailableError(this.sessionId, this.state)
		}
		return release
	}

	tryAcquire(reason: string): RuntimeLeaseRelease | null {
		if (this.state !== 'ready') return null
		return this.takeLease(reason)
	}

	private takeLease(reason: string): RuntimeLeaseRelease {
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
			if (this.activeCount === 0) for (const resolve of this.idleWaiters) resolve()
		}
	}

	tryBeginUnload(): boolean {
		if (this.state !== 'ready' || this.activeCount !== 0) return false
		this.state = 'unloading'
		return true
	}

	beginForcedUnload(): void {
		if (this.state === 'parking') {
			this.state = 'unloading'
			this.revoked.reject(new SessionRuntimeUnavailableError(this.sessionId, this.state))
		}
		if (this.state === 'ready') this.state = 'unloading'
	}

	markDisposed(): void {
		if (this.state !== 'revoked') this.state = 'disposed'
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
