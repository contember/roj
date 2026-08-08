import { describe, expect, it } from 'bun:test'
import { createTimerScheduler, isLiveScheduler, type Scheduler } from './scheduler.js'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

describe('createTimerScheduler', () => {
	it('delivers a wake to the registered handler after the delay', async () => {
		const scheduler = createTimerScheduler()
		const fired: string[] = []
		scheduler.onWake((key) => {
			fired.push(key)
		})

		await scheduler.wake('a', 5)
		expect(fired).toEqual([])

		await sleep(30)
		expect(fired).toEqual(['a'])
	})

	it('replaces a pending wake for the same key', async () => {
		const scheduler = createTimerScheduler()
		const fired: string[] = []
		scheduler.onWake((key) => {
			fired.push(key)
		})

		await scheduler.wake('a', 5)
		await scheduler.wake('a', 40)

		await sleep(20)
		expect(fired).toEqual([])

		await sleep(50)
		expect(fired).toEqual(['a'])
	})

	it('keeps wakes for different keys independent', async () => {
		const scheduler = createTimerScheduler()
		const fired: string[] = []
		scheduler.onWake((key) => {
			fired.push(key)
		})

		await scheduler.wake('a', 5)
		await scheduler.wake('b', 5)

		await sleep(30)
		expect(fired.sort()).toEqual(['a', 'b'])
	})

	it('cancel stops a pending wake', async () => {
		const scheduler = createTimerScheduler()
		const fired: string[] = []
		scheduler.onWake((key) => {
			fired.push(key)
		})

		await scheduler.wake('a', 5)
		await scheduler.cancel('a')

		await sleep(30)
		expect(fired).toEqual([])
	})

	it('cancel for an unknown key is a no-op', async () => {
		const scheduler = createTimerScheduler()
		await scheduler.cancel('never-armed')
	})

	it('arms synchronously, so a cancel issued after a wake always wins', async () => {
		const scheduler = createTimerScheduler()
		const fired: string[] = []
		scheduler.onWake((key) => {
			fired.push(key)
		})

		// Both promises left unawaited, the way the agent loop issues them.
		void scheduler.wake('a', 5)
		void scheduler.cancel('a')

		await sleep(30)
		expect(fired).toEqual([])
	})

	it('drops a wake with no handler registered instead of throwing', async () => {
		const scheduler = createTimerScheduler()
		await scheduler.wake('a', 5)
		await sleep(30)
	})

	it('does not surface a rejecting handler as an unhandled rejection', async () => {
		const scheduler = createTimerScheduler()
		scheduler.onWake(async () => {
			throw new Error('dispatch blew up')
		})

		await scheduler.wake('a', 5)
		await sleep(30)
	})
})

describe('isLiveScheduler', () => {
	it('is true for the timer scheduler', () => {
		expect(isLiveScheduler(createTimerScheduler())).toBe(true)
	})

	it('is false for a scheduler that only arms wakes', () => {
		const outOfBand: Scheduler = {
			wake: async () => {},
			cancel: async () => {},
		}
		expect(isLiveScheduler(outOfBand)).toBe(false)
	})
})
