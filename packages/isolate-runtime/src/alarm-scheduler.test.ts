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

	test('a throwing delivery does not strand the other wakes, and is delivered again', async () => {
		setSystemTime(T0)
		const storage = new MemoryAlarmStorage()
		const scheduler = createAlarmScheduler({ storage, inFlightRetryMs: 60_000 })
		await scheduler.wake('a', 0)
		await scheduler.wake('b', 0)

		const delivered: string[] = []
		await scheduler.deliverDue(async key => {
			delivered.push(key)
			if (key === 'a') throw new Error('boom')
		})

		expect(delivered).toEqual(['a', 'b'])
		expect(scheduler.stats()).toMatchObject({ pending: 0, inFlight: 1 })
		expect(storage.alarm).toBe(T0 + 60_000)

		setSystemTime(T0 + 60_000)
		expect(await scheduler.deliverDue(async () => {})).toEqual(['a'])
		expect(scheduler.stats()).toMatchObject({ pending: 0, inFlight: 0 })
	})

	test('delivers due wakes concurrently, so a long turn does not hold up the others', async () => {
		setSystemTime(T0)
		const storage = new MemoryAlarmStorage()
		const scheduler = createAlarmScheduler({ storage })
		await scheduler.wake('long', 0)
		await scheduler.wake('short', 0)

		let finishLong = () => {}
		const finished: string[] = []
		const draining = scheduler.deliverDue(async key => {
			if (key === 'long') await new Promise<void>(resolve => (finishLong = resolve))
			finished.push(key)
		})
		await Bun.sleep(0)

		expect(finished).toEqual(['short'])
		finishLong()
		await draining
		expect(finished).toEqual(['short', 'long'])
	})

	test('flush writes the slot again after a failed write, and throws when that fails too', async () => {
		setSystemTime(T0)
		const storage = new MemoryAlarmStorage()
		let failures = 1
		const flaky = {
			kv: storage.kv,
			setAlarm: async (at: number) => {
				if (failures-- > 0) throw new Error('slot unavailable')
				await storage.setAlarm(at)
			},
			deleteAlarm: () => storage.deleteAlarm(),
		}
		const scheduler = createAlarmScheduler({ storage: flaky })

		await expect(scheduler.wake('a', 1_000)).rejects.toThrow('slot unavailable')
		await scheduler.flush()
		expect(storage.alarm).toBe(T0 + 1_000)

		failures = 2
		await expect(scheduler.wake('b', 500)).rejects.toThrow('slot unavailable')
		await expect(scheduler.flush()).rejects.toThrow('slot unavailable')
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
