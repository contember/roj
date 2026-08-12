import { describe, expect, spyOn, test } from 'bun:test'
import { sleep } from './sleep.js'

describe('sleep', () => {
	test('does not retain abort listeners across completed waits', async () => {
		const controller = new AbortController()
		const addListenerSpy = spyOn(controller.signal, 'addEventListener')
		const removeListenerSpy = spyOn(controller.signal, 'removeEventListener')

		for (let wait = 0; wait < 3; wait++) {
			await sleep(0, controller.signal)
		}

		expect(addListenerSpy).toHaveBeenCalledTimes(3)
		expect(removeListenerSpy).toHaveBeenCalledTimes(3)
		for (let wait = 0; wait < 3; wait++) {
			expect(removeListenerSpy.mock.calls[wait]?.[1]).toBe(
				addListenerSpy.mock.calls[wait]?.[1],
			)
		}
	})

	test('removes its abort listener when aborted', async () => {
		const controller = new AbortController()
		const addListenerSpy = spyOn(controller.signal, 'addEventListener')
		const removeListenerSpy = spyOn(controller.signal, 'removeEventListener')
		const sleepPromise = sleep(60_000, controller.signal)

		controller.abort()
		await sleepPromise

		expect(addListenerSpy).toHaveBeenCalledTimes(1)
		expect(removeListenerSpy).toHaveBeenCalledTimes(1)
		expect(removeListenerSpy.mock.calls[0]?.[1]).toBe(addListenerSpy.mock.calls[0]?.[1])
	})

	test('an already-aborted signal resolves without adding a listener', async () => {
		const controller = new AbortController()
		controller.abort()
		const addListenerSpy = spyOn(controller.signal, 'addEventListener')

		await sleep(60_000, controller.signal)

		expect(addListenerSpy).not.toHaveBeenCalled()
	})
})
