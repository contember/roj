import { describe, expect, it } from 'bun:test'
import { shutdownFromSignal } from '../src/server.js'

describe('shutdownFromSignal', () => {
	it('reports a rejected shutdown and still exits', async () => {
		const failure = new Error('shutdown failed')
		const reported: Array<{ message: string; error: unknown }> = []
		const exitCodes: number[] = []

		await shutdownFromSignal(
			async () => {
				throw failure
			},
			(message, error) => reported.push({ message, error }),
			(code) => exitCodes.push(code),
		)

		expect(reported).toEqual([{ message: 'Shutdown failed', error: failure }])
		expect(exitCodes).toEqual([0])
	})
})
