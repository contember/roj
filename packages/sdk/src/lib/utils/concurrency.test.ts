import { describe, expect, it, spyOn } from 'bun:test'
import { mapWithConcurrency, Semaphore } from './concurrency.js'

function defer<T = void>(): {
	promise: Promise<T>
	resolve: (v: T) => void
	reject: (e: unknown) => void
} {
	let resolve!: (v: T) => void
	let reject!: (e: unknown) => void
	const promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}

describe('mapWithConcurrency', () => {
	it('preserves input order regardless of completion order', async () => {
		const delays = [50, 10, 30, 5, 20]
		const results = await mapWithConcurrency(delays, 3, async (ms, i) => {
			await new Promise(r => setTimeout(r, ms))
			return `${i}:${ms}`
		})
		expect(results).toEqual(['0:50', '1:10', '2:30', '3:5', '4:20'])
	})

	it('does not exceed the concurrency limit', async () => {
		let active = 0
		let peak = 0
		const items = Array.from({ length: 20 }, (_, i) => i)

		await mapWithConcurrency(items, 4, async () => {
			active++
			peak = Math.max(peak, active)
			await new Promise(r => setTimeout(r, 5))
			active--
		})

		expect(peak).toBeLessThanOrEqual(4)
		expect(peak).toBe(4)
	})

	it('handles empty input without spawning workers', async () => {
		let calls = 0
		const results = await mapWithConcurrency([], 5, async () => {
			calls++
			return 1
		})
		expect(results).toEqual([])
		expect(calls).toBe(0)
	})

	it('caps worker count at item count when concurrency > items', async () => {
		let active = 0
		let peak = 0
		const items = [1, 2]

		await mapWithConcurrency(items, 10, async () => {
			active++
			peak = Math.max(peak, active)
			await new Promise(r => setTimeout(r, 5))
			active--
		})

		expect(peak).toBe(2)
	})

	it('propagates errors thrown by the worker fn', async () => {
		await expect(
			mapWithConcurrency([1, 2, 3], 2, async n => {
				if (n === 2) throw new Error('boom')
				return n
			}),
		).rejects.toThrow('boom')
	})
})

describe('Semaphore', () => {
	it('rejects invalid limits', () => {
		expect(() => new Semaphore(0)).toThrow()
		expect(() => new Semaphore(-1)).toThrow()
		expect(() => new Semaphore(1.5)).toThrow()
	})

	it('caps concurrent executions at limit', async () => {
		const gate = new Semaphore(3)
		let active = 0
		let peak = 0

		const tasks = Array.from({ length: 12 }, () =>
			gate.run(async () => {
				active++
				peak = Math.max(peak, active)
				await new Promise(r => setTimeout(r, 10))
				active--
			}),
		)

		await Promise.all(tasks)
		expect(peak).toBe(3)
		expect(active).toBe(0)
	})

	it('admits waiters in FIFO order', async () => {
		const gate = new Semaphore(1)
		const order: number[] = []
		const blocker = defer()

		// Hold the only slot
		const held = gate.run(async () => {
			await blocker.promise
		})

		// Queue three waiters in known order, with their own blockers so the test
		// can observe entry order without relying on real timers.
		const gates = [defer(), defer(), defer()]
		const queued = gates.map((g, i) =>
			gate.run(async () => {
				order.push(i)
				await g.promise
			}),
		)

		// Yield so all three are queued.
		await new Promise(r => setTimeout(r, 0))
		expect(order).toEqual([])

		// Release the holder; waiter 0 should run first.
		blocker.resolve()
		await new Promise(r => setTimeout(r, 0))
		expect(order).toEqual([0])

		gates[0]!.resolve()
		await new Promise(r => setTimeout(r, 0))
		expect(order).toEqual([0, 1])

		gates[1]!.resolve()
		await new Promise(r => setTimeout(r, 0))
		expect(order).toEqual([0, 1, 2])

		gates[2]!.resolve()
		await Promise.all([held, ...queued])
	})

	it('releases the slot when the body throws', async () => {
		const gate = new Semaphore(1)

		await expect(
			gate.run(async () => {
				throw new Error('boom')
			}),
		).rejects.toThrow('boom')

		// Slot must be free again — this would deadlock otherwise.
		const result = await gate.run(async () => 42)
		expect(result).toBe(42)
	})

	it('rejects a pre-aborted run without invoking its body', async () => {
		const gate = new Semaphore(1)
		const controller = new AbortController()
		const reason = new Error('cancelled before acquire')
		let invoked = false
		controller.abort(reason)

		await expect(
			gate.run(async () => {
				invoked = true
			}, controller.signal),
		).rejects.toBe(reason)
		expect(invoked).toBe(false)

		await expect(gate.run(async () => 'next')).resolves.toBe('next')
	})

	it('removes an aborted queued waiter and preserves FIFO capacity', async () => {
		const gate = new Semaphore(1)
		const holderRelease = defer()
		const firstRelease = defer()
		const events: string[] = []
		const controller = new AbortController()
		const reason = new Error('cancel queued waiter')

		const holder = gate.run(async () => {
			events.push('holder')
			await holderRelease.promise
		})
		const first = gate.run(async () => {
			events.push('first')
			await firstRelease.promise
		})
		let cancelledInvoked = false
		const cancelled = gate.run(async () => {
			cancelledInvoked = true
		}, controller.signal)
		const third = gate.run(async () => {
			events.push('third')
		})

		controller.abort(reason)
		await expect(cancelled).rejects.toBe(reason)
		expect(cancelledInvoked).toBe(false)

		holderRelease.resolve()
		await new Promise(resolve => setTimeout(resolve, 0))
		expect(events).toEqual(['holder', 'first'])

		firstRelease.resolve()
		await Promise.all([holder, first, third])
		expect(events).toEqual(['holder', 'first', 'third'])

		await expect(gate.run(async () => 'capacity remains usable')).resolves.toBe('capacity remains usable')
	})

	it('releases a transferred permit when abort wins before the waiter continuation', async () => {
		const gate = new Semaphore(1)
		const holderStarted = defer()
		const holderRelease = defer()
		const controller = new AbortController()
		const reason = new Error('cancel during permit handoff')
		const removeListenerSpy = spyOn(controller.signal, 'removeEventListener')
		let cancelledInvoked = false
		let trailingInvoked = false

		const holder = gate.run(async () => {
			holderStarted.resolve()
			await holderRelease.promise
		})
		await holderStarted.promise
		const cancelled = gate.run(async () => {
			cancelledInvoked = true
		}, controller.signal)
		const trailing = gate.run(async () => {
			trailingInvoked = true
		})

		holderRelease.resolve()
		queueMicrotask(() => queueMicrotask(() => controller.abort(reason)))

		await expect(cancelled).rejects.toBe(reason)
		await Promise.all([holder, trailing])
		expect(cancelledInvoked).toBe(false)
		expect(trailingInvoked).toBe(true)
		expect(removeListenerSpy).toHaveBeenCalled()
		await expect(gate.run(async () => 'still usable')).resolves.toBe('still usable')
	})

	it('serializes work under limit=1', async () => {
		const gate = new Semaphore(1)
		const events: string[] = []

		const tasks = [0, 1, 2].map(i =>
			gate.run(async () => {
				events.push(`start:${i}`)
				await new Promise(r => setTimeout(r, 5))
				events.push(`end:${i}`)
			}),
		)

		await Promise.all(tasks)
		expect(events).toEqual(['start:0', 'end:0', 'start:1', 'end:1', 'start:2', 'end:2'])
	})
})
