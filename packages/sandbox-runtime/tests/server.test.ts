import { describe, expect, it } from 'bun:test'
import {
	createServerLifecycle,
	runServerStartup,
	ServerCleanupError,
	shutdownFromSignal,
	StartupInterruptedError,
	type ServerSignal,
	type SignalListenerRegistry,
} from '@roj-ai/sdk/bun-platform'

class FakeSignalListeners implements SignalListenerRegistry {
	private readonly listeners = new Map<ServerSignal, Set<() => void>>()

	add(signal: ServerSignal, listener: () => void): void {
		const listeners = this.listeners.get(signal) ?? new Set()
		listeners.add(listener)
		this.listeners.set(signal, listeners)
	}

	remove(signal: ServerSignal, listener: () => void): void {
		this.listeners.get(signal)?.delete(listener)
	}

	emit(signal: ServerSignal): void {
		for (const listener of this.listeners.get(signal) ?? []) listener()
	}

	count(signal: ServerSignal): number {
		return this.listeners.get(signal)?.size ?? 0
	}
}

describe('server lifecycle', () => {
	it('coalesces shutdown, stops ingress synchronously, and attempts every cleanup step once', async () => {
		const firstFailure = new Error('stop failed')
		const secondFailure = new Error('session cleanup failed')
		let rejectIngress = (error: unknown) => {}
		const ingressPending = new Promise<void>((_resolve, reject) => {
			rejectIngress = reject
		})
		const calls: string[] = []
		const signals = new FakeSignalListeners()
		const lifecycle = createServerLifecycle({
			stopIngress: () => {
				calls.push('ingress')
				return ingressPending
			},
			cleanupSteps: [
				() => calls.push('callback'),
				() => {
					calls.push('sessions')
					throw secondFailure
				},
				() => calls.push('transport'),
			],
			runSignalShutdown: shutdown => {
				void shutdown()
			},
		}, signals)

		const firstShutdown = lifecycle.shutdown()
		const observedShutdown = firstShutdown.catch(error => error)
		const secondShutdown = lifecycle.shutdown()
		expect(secondShutdown).toBe(firstShutdown)
		expect(calls).toEqual(['ingress'])
		expect(signals.count('SIGINT')).toBe(1)
		expect(signals.count('SIGTERM')).toBe(1)

		rejectIngress(firstFailure)
		const caught: unknown = await observedShutdown

		expect(caught).toBeInstanceOf(ServerCleanupError)
		if (!(caught instanceof ServerCleanupError)) throw new Error('Expected ServerCleanupError')
		expect(caught.orderedErrors).toEqual([firstFailure, secondFailure])
		expect(calls).toEqual(['ingress', 'callback', 'sessions', 'transport'])
		expect(signals.count('SIGINT')).toBe(0)
		expect(signals.count('SIGTERM')).toBe(0)
		expect(lifecycle.shutdown()).toBe(firstShutdown)
	})

	it('installs named signal listeners and handles SIGINT plus SIGTERM only once', async () => {
		const calls: string[] = []
		const signals = new FakeSignalListeners()
		let signalRuns = 0
		let signalShutdown: Promise<void> | undefined
		const lifecycle = createServerLifecycle({
			stopIngress: () => calls.push('ingress'),
			cleanupSteps: [],
			runSignalShutdown: shutdown => {
				signalRuns++
				signalShutdown = shutdown()
			},
		}, signals)

		expect(signals.count('SIGINT')).toBe(1)
		expect(signals.count('SIGTERM')).toBe(1)
		signals.emit('SIGINT')
		signals.emit('SIGTERM')
		await signalShutdown

		expect(signalRuns).toBe(1)
		expect(calls).toEqual(['ingress'])
		expect(lifecycle.isShuttingDown()).toBe(true)
	})

	it('treats startup rejection as fatal and preserves cleanup errors after it', async () => {
		const startupFailure = new Error('load failed')
		const ingressFailure = new Error('stop failed')
		const transportFailure = new Error('transport cleanup failed')
		const calls: string[] = []
		const lifecycle = createServerLifecycle({
			stopIngress: () => {
				calls.push('ingress')
				throw ingressFailure
			},
			cleanupSteps: [
				() => calls.push('sessions'),
				() => {
					calls.push('transport')
					throw transportFailure
				},
			],
			runSignalShutdown: shutdown => {
				void shutdown()
			},
		}, new FakeSignalListeners())

		let caught: unknown
		try {
			await runServerStartup(lifecycle, [{ run: async () => {
				throw startupFailure
			} }])
		} catch (error) {
			caught = error
		}

		expect(caught).toBeInstanceOf(AggregateError)
		if (!(caught instanceof AggregateError)) throw new Error('Expected AggregateError')
		expect(caught.errors).toEqual([startupFailure, ingressFailure, transportFailure])
		expect(caught.cause).toBe(startupFailure)
		expect(calls).toEqual(['ingress', 'sessions', 'transport'])
	})

	it.each(['load', 'start'])('defers cleanup until a pending %s stage settles', async (stageName) => {
		let releaseStartup = () => {}
		const pendingStartup = new Promise<void>(resolve => {
			releaseStartup = resolve
		})
		let markStageEntered = () => {}
		const stageEntered = new Promise<void>(resolve => {
			markStageEntered = resolve
		})
		const signals = new FakeSignalListeners()
		let signalTask: Promise<void> | undefined
		const exitCodes: number[] = []
		let signalRuns = 0
		let ingressRuns = 0
		let nextStepRuns = 0
		const cleanupCalls: string[] = []
		const lifecycle = createServerLifecycle({
			stopIngress: () => {
				ingressRuns++
			},
			cleanupSteps: [
				() => cleanupCalls.push('sessions'),
				() => cleanupCalls.push('transport'),
			],
			runSignalShutdown: shutdown => {
				signalRuns++
				signalTask = shutdownFromSignal(shutdown, undefined, code => exitCodes.push(code))
			},
		}, signals)

		const deferredStage = () => {
			markStageEntered()
			return pendingStartup
		}
		const followingStage = async () => {
			nextStepRuns++
		}
		const startup = runServerStartup(lifecycle, stageName === 'load'
			? [{ run: deferredStage }, { run: followingStage }]
			: [{ run: async () => {} }, { run: deferredStage }])
		await stageEntered
		signals.emit('SIGTERM')
		signals.emit('SIGINT')

		expect(ingressRuns).toBe(1)
		expect(cleanupCalls).toEqual([])
		expect(exitCodes).toEqual([])
		expect(signalRuns).toBe(1)
		expect(signals.count('SIGINT')).toBe(1)
		expect(signals.count('SIGTERM')).toBe(1)

		releaseStartup()

		await expect(startup).rejects.toBeInstanceOf(StartupInterruptedError)
		await signalTask
		expect(nextStepRuns).toBe(0)
		expect(cleanupCalls).toEqual(['sessions', 'transport'])
		expect(exitCodes).toEqual([0])
		expect(signals.count('SIGINT')).toBe(0)
		expect(signals.count('SIGTERM')).toBe(0)
	})

	it('joins shutdown when a pending startup rejection races a signal', async () => {
		const startupFailure = new Error('load failed')
		let rejectStartup = (_error: unknown) => {}
		const pendingStartup = new Promise<void>((_resolve, reject) => {
			rejectStartup = reject
		})
		const signals = new FakeSignalListeners()
		let signalTask: Promise<void> | undefined
		let cleanupRuns = 0
		const lifecycle = createServerLifecycle({
			stopIngress: () => {},
			cleanupSteps: [() => {
				cleanupRuns++
			}],
			runSignalShutdown: shutdown => {
				signalTask = shutdownFromSignal(shutdown, undefined, () => {})
			},
		}, signals)

		const startup = runServerStartup(lifecycle, [{ run: () => pendingStartup }])
		signals.emit('SIGINT')
		expect(cleanupRuns).toBe(0)
		rejectStartup(startupFailure)

		await expect(startup).rejects.toBeInstanceOf(StartupInterruptedError)
		await signalTask
		expect(cleanupRuns).toBe(1)
	})

	it('cancels a blocking transport start and stops transport only once', async () => {
		let settleStart = () => {}
		const calls: string[] = []
		const transport = {
			start() {
				calls.push('transport.start')
				return new Promise<void>(resolve => {
					settleStart = resolve
				})
			},
			async stop() {
				calls.push('transport.stop')
				settleStart()
			},
		}
		let stopPromise: Promise<void> | undefined
		const stopTransportOnce = () => {
			stopPromise ??= transport.stop()
			return stopPromise
		}
		const signals = new FakeSignalListeners()
		const exitCodes: number[] = []
		let signalTask: Promise<void> | undefined
		let markStartEntered = () => {}
		const startEntered = new Promise<void>(resolve => {
			markStartEntered = resolve
		})
		const lifecycle = createServerLifecycle({
			stopIngress: () => calls.push('ingress'),
			cleanupSteps: [
				() => calls.push('callback'),
				() => calls.push('sessions'),
				stopTransportOnce,
			],
			runSignalShutdown: shutdown => {
				signalTask = shutdownFromSignal(shutdown, undefined, code => exitCodes.push(code))
			},
		}, signals)
		const startup = runServerStartup(lifecycle, [
			{ run: async () => {} },
			{
				run: () => {
					markStartEntered()
					return transport.start()
				},
				cancel: stopTransportOnce,
			},
		])

		await startEntered
		signals.emit('SIGTERM')
		await expect(startup).rejects.toBeInstanceOf(StartupInterruptedError)
		await signalTask

		expect(calls).toEqual([
			'transport.start',
			'ingress',
			'transport.stop',
			'callback',
			'sessions',
		])
		expect(exitCodes).toEqual([0])
		expect(signals.count('SIGINT')).toBe(0)
		expect(signals.count('SIGTERM')).toBe(0)
	})
})

describe('shutdownFromSignal', () => {
	it('reports a rejected shutdown and exits with failure', async () => {
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
		expect(exitCodes).toEqual([1])
	})

	it('exits successfully after clean shutdown', async () => {
		const exitCodes: number[] = []
		await shutdownFromSignal(async () => {}, undefined, code => exitCodes.push(code))
		expect(exitCodes).toEqual([0])
	})
})
