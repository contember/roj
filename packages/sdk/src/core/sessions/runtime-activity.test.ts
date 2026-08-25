import { describe, expect, test } from 'bun:test'
import { SessionRuntimeActivityController } from '~/core/sessions/runtime-activity.js'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

describe('SessionRuntimeActivityController leases', () => {
	test('acquire holds the runtime and release lets it go', () => {
		const c = new SessionRuntimeActivityController()
		const release = c.acquire('work')
		expect(c.getSnapshot().activeCount).toBe(1)
		expect(c.getSnapshot().reasons).toEqual({ work: 1 })
		expect(c.tryBeginUnload()).toBe(false)

		release()
		expect(c.getSnapshot().activeCount).toBe(0)
		expect(c.getSnapshot().reasons).toEqual({})
		expect(c.tryBeginUnload()).toBe(true)
	})

	test('two leases sharing a reason decrement instead of dropping the entry', () => {
		const c = new SessionRuntimeActivityController()
		const first = c.acquire('agent:processing')
		const second = c.acquire('agent:processing')
		expect(c.getSnapshot().reasons).toEqual({ 'agent:processing': 2 })

		first()
		expect(c.getSnapshot().activeCount).toBe(1)
		expect(c.getSnapshot().reasons).toEqual({ 'agent:processing': 1 })

		second()
		expect(c.getSnapshot().activeCount).toBe(0)
		expect(c.getSnapshot().reasons).toEqual({})
	})

	test('releasing twice does not decrement twice', () => {
		const c = new SessionRuntimeActivityController()
		const other = c.acquire('keep')
		const release = c.acquire('once')
		release()
		release()
		release()
		expect(c.getSnapshot().activeCount).toBe(1)
		expect(c.getSnapshot().reasons).toEqual({ keep: 1 })
		other()
		expect(c.getSnapshot().activeCount).toBe(0)
	})

	test('a released lease from a shared reason does not steal the sibling count', () => {
		const c = new SessionRuntimeActivityController()
		const first = c.acquire('shared')
		c.acquire('shared')
		first()
		first()
		expect(c.getSnapshot().reasons).toEqual({ shared: 1 })
		expect(c.getSnapshot().activeCount).toBe(1)
	})

	test('the snapshot reasons map is a detached copy', () => {
		const c = new SessionRuntimeActivityController()
		const release = c.acquire('work')
		const snapshot = c.getSnapshot()
		release()
		expect(snapshot.reasons).toEqual({ work: 1 })
		expect(c.getSnapshot().reasons).toEqual({})
	})

	test('lease and release both count as activity', async () => {
		const c = new SessionRuntimeActivityController()
		const created = c.getSnapshot().lastActivityAt
		await sleep(2)
		const release = c.acquire('work')
		const acquired = c.getSnapshot().lastActivityAt
		expect(acquired).toBeGreaterThan(created)
		await sleep(2)
		release()
		expect(c.getSnapshot().lastActivityAt).toBeGreaterThan(acquired)
	})
})

describe('SessionRuntimeActivityController state transitions', () => {
	test('unloading refuses new work', () => {
		const c = new SessionRuntimeActivityController()
		c.beginForcedUnload()
		expect(c.getSnapshot().state).toBe('unloading')
		expect(c.tryAcquire('late')).toBeNull()
		expect(() => c.acquire('late')).toThrow('Session runtime is unloading')
	})

	test('disposed refuses new work and says so', () => {
		const c = new SessionRuntimeActivityController()
		c.markDisposed()
		expect(c.getSnapshot().state).toBe('disposed')
		expect(c.tryAcquire('late')).toBeNull()
		expect(() => c.acquire('late')).toThrow('Session runtime is disposed')
	})

	test('tryBeginUnload only wins once, and only from idle ready', () => {
		const c = new SessionRuntimeActivityController()
		const release = c.acquire('work')
		expect(c.tryBeginUnload()).toBe(false)
		expect(c.getSnapshot().state).toBe('ready')

		release()
		expect(c.tryBeginUnload()).toBe(true)
		expect(c.tryBeginUnload()).toBe(false)
		expect(c.getSnapshot().state).toBe('unloading')
	})

	test('a forced unload takes the runtime down under a live lease', () => {
		const c = new SessionRuntimeActivityController()
		const release = c.acquire('work')
		c.beginForcedUnload()
		expect(c.getSnapshot().state).toBe('unloading')
		expect(c.getSnapshot().activeCount).toBe(1)

		release()
		expect(c.getSnapshot().activeCount).toBe(0)
		expect(c.getSnapshot().reasons).toEqual({})
		expect(c.getSnapshot().state).toBe('unloading')
	})

	test('a forced unload never revives a disposed runtime', () => {
		const c = new SessionRuntimeActivityController()
		c.markDisposed()
		c.beginForcedUnload()
		expect(c.getSnapshot().state).toBe('disposed')
	})

	test('markDisposed is the terminal state from unloading', () => {
		const c = new SessionRuntimeActivityController()
		expect(c.tryBeginUnload()).toBe(true)
		c.markDisposed()
		c.markDisposed()
		expect(c.getSnapshot().state).toBe('disposed')
		expect(c.tryBeginUnload()).toBe(false)
	})
})
