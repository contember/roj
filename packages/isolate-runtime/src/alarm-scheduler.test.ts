import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { createAlarmScheduler } from './alarm-scheduler.js'
import { MemoryAlarmStorage } from './testing.js'

const T0 = Date.parse('2026-10-12T10:00:00Z')

afterEach(() => setSystemTime())

describe('alarm scheduler', () => {
	test('arms the earliest wake and moves the alarm as wakes come and go', async () => {
		setSystemTime(T0)
		const storage = new MemoryAlarmStorage()
		const scheduler = createAlarmScheduler({ storage })

		await scheduler.wake('a', 5_000)
		await scheduler.wake('b', 1_000)
		expect(storage.alarm).toBe(T0 + 1_000)

		await scheduler.cancel('b')
		expect(storage.alarm).toBe(T0 + 5_000)

		await scheduler.cancel('a')
		expect(storage.alarm).toBeNull()
	})

	test('delivers due wakes, keeps the rest armed, and survives a new isolate', async () => {
		setSystemTime(T0)
		const storage = new MemoryAlarmStorage()
		await createAlarmScheduler({ storage }).wake('due', 0)
		await createAlarmScheduler({ storage }).wake('later', 60_000)

		const delivered: string[] = []
		const scheduler = createAlarmScheduler({ storage })
		expect(await scheduler.deliverDue(async key => void delivered.push(key))).toEqual(['due'])

		expect(delivered).toEqual(['due'])
		expect(storage.alarm).toBe(T0 + 60_000)
		expect(scheduler.stats()).toMatchObject({ pending: 1, inFlight: 0 })
	})

	test('a delivery that never finishes is delivered again after the retry delay', async () => {
		setSystemTime(T0)
		const storage = new MemoryAlarmStorage()
		const first = createAlarmScheduler({ storage, inFlightRetryMs: 60_000 })
		await first.wake('turn', 0)

		// The isolate is evicted mid-delivery: the handler never returns.
		void first.deliverDue(() => new Promise<void>(() => {}))
		await first.flush()
		expect(storage.alarm).toBe(T0 + 60_000)

		setSystemTime(T0 + 60_000)
		const delivered: string[] = []
		const second = createAlarmScheduler({ storage, inFlightRetryMs: 60_000 })
		expect(second.stats()).toMatchObject({ pending: 0, inFlight: 1 })
		expect(await second.deliverDue(async key => void delivered.push(key))).toEqual(['turn'])

		expect(delivered).toEqual(['turn'])
		expect(second.stats()).toMatchObject({ pending: 0, inFlight: 0 })
		expect(storage.alarm).toBeNull()
	})

	test('a finished delivery clears its retry but keeps a wake the turn armed for itself', async () => {
		setSystemTime(T0)
		const storage = new MemoryAlarmStorage()
		const scheduler = createAlarmScheduler({ storage, inFlightRetryMs: 60_000 })
		await scheduler.wake('turn', 0)

		await scheduler.deliverDue(async key => {
			await scheduler.wake(key, 500)
		})
		await scheduler.flush()

		expect(scheduler.stats()).toMatchObject({ pending: 1, inFlight: 0 })
		expect(storage.alarm).toBe(T0 + 500)
	})

	test('a throwing delivery does not strand the wakes behind it', async () => {
		setSystemTime(T0)
		const storage = new MemoryAlarmStorage()
		const scheduler = createAlarmScheduler({ storage })
		await scheduler.wake('a', 0)
		await scheduler.wake('b', 0)

		const delivered: string[] = []
		await scheduler.deliverDue(async key => {
			delivered.push(key)
			if (key === 'a') throw new Error('boom')
		})

		expect(delivered).toEqual(['a', 'b'])
		expect(scheduler.stats()).toMatchObject({ pending: 0, inFlight: 0 })
	})

	test('ignores wakes and cancels while suspended', async () => {
		setSystemTime(T0)
		const storage = new MemoryAlarmStorage()
		const scheduler = createAlarmScheduler({ storage })
		await scheduler.wake('kept', 1_000)

		await scheduler.suspend(async () => {
			await scheduler.cancel('kept')
			await scheduler.wake('dropped', 0)
		})

		expect(scheduler.stats().pending).toBe(1)
		expect(storage.alarm).toBe(T0 + 1_000)
	})
})
