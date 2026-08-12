export type ServerSignal = 'SIGINT' | 'SIGTERM'

export interface SignalListenerRegistry {
	add(signal: ServerSignal, listener: () => void): void
	remove(signal: ServerSignal, listener: () => void): void
}

export interface ServerLifecycle {
	shutdown(): Promise<void>
	isShuttingDown(): boolean
	runStartupStage(stage: StartupStage): Promise<void>
}

export interface StartupStage {
	run: () => Promise<void>
	cancel?: () => Promise<void> | void
}

export interface ServerLifecycleOptions {
	stopIngress: () => Promise<void> | void
	cleanupSteps: ReadonlyArray<() => Promise<void> | void>
	runSignalShutdown: (shutdown: () => Promise<void>) => void
}

export class ServerCleanupError extends AggregateError {
	readonly orderedErrors: readonly unknown[]

	constructor(errors: readonly unknown[]) {
		super(errors, 'Server shutdown failed')
		this.name = 'ServerCleanupError'
		this.orderedErrors = errors
	}
}

export class StartupInterruptedError extends Error {
	constructor() {
		super('Server startup was interrupted by shutdown')
		this.name = 'StartupInterruptedError'
	}
}

const processSignalListeners: SignalListenerRegistry = {
	add(signal, listener) {
		process.on(signal, listener)
	},
	remove(signal, listener) {
		process.off(signal, listener)
	},
}

export function createServerLifecycle(
	options: ServerLifecycleOptions,
	signalListeners: SignalListenerRegistry = processSignalListeners,
): ServerLifecycle {
	let shutdownPromise: Promise<void> | undefined
	let shuttingDown = false
	let activeStartupStage: { promise: Promise<void>; cancel?: () => Promise<void> | void } | undefined
	let listenersInstalled = true
	let signalHandled = false

	const removeSignalListeners = () => {
		if (!listenersInstalled) return
		listenersInstalled = false
		signalListeners.remove('SIGINT', handleSigint)
		signalListeners.remove('SIGTERM', handleSigterm)
	}

	const finishCleanup = async (
		ingressResult: Promise<void> | void,
		startupStage: { promise: Promise<void>; cancel?: () => Promise<void> | void } | undefined,
	) => {
		const errors: unknown[] = []
		let cancellationError: unknown
		let cancellationFailed = false
		let cancellationSettled: Promise<void> | undefined
		if (startupStage?.cancel) {
			try {
				cancellationSettled = Promise.resolve(startupStage.cancel()).catch((error) => {
					cancellationFailed = true
					cancellationError = error
				})
			} catch (error) {
				cancellationFailed = true
				cancellationError = error
			}
		}

		try {
			await ingressResult
		} catch (error) {
			errors.push(error)
		}

		await cancellationSettled
		if (cancellationFailed) errors.push(cancellationError)

		if (startupStage) {
			try {
				await startupStage.promise
			} catch {
				// Startup reports its own failure after joining shutdown.
			}
		}

		for (const step of options.cleanupSteps) {
			try {
				await step()
			} catch (error) {
				errors.push(error)
			}
		}

		if (errors.length === 1) throw errors[0]
		if (errors.length > 1) throw new ServerCleanupError(errors)
	}

	const shutdown = (): Promise<void> => {
		if (shutdownPromise) return shutdownPromise

		shuttingDown = true
		const startupStage = activeStartupStage
		let resolveShutdown = () => {}
		let rejectShutdown = (_error: unknown) => {}
		shutdownPromise = new Promise<void>((resolve, reject) => {
			resolveShutdown = resolve
			rejectShutdown = reject
		})

		let ingressResult: Promise<void> | void
		try {
			ingressResult = options.stopIngress()
		} catch (error) {
			ingressResult = Promise.reject(error)
		}

		void (async () => {
			try {
				await finishCleanup(ingressResult, startupStage)
				removeSignalListeners()
				resolveShutdown()
			} catch (error) {
				removeSignalListeners()
				rejectShutdown(error)
			}
		})()
		return shutdownPromise
	}

	const beginSignalShutdown = () => {
		if (signalHandled) return
		signalHandled = true
		options.runSignalShutdown(shutdown)
	}

	function handleSigint() {
		beginSignalShutdown()
	}

	function handleSigterm() {
		beginSignalShutdown()
	}

	signalListeners.add('SIGINT', handleSigint)
	signalListeners.add('SIGTERM', handleSigterm)

	return {
		shutdown,
		isShuttingDown: () => shuttingDown,
		async runStartupStage(stage) {
			if (shuttingDown) throw new StartupInterruptedError()
			const runningStage = Promise.resolve().then(stage.run)
			const activeStage = { promise: runningStage, cancel: stage.cancel }
			activeStartupStage = activeStage
			try {
				await runningStage
			} finally {
				if (activeStartupStage === activeStage) activeStartupStage = undefined
			}
		},
	}
}

export async function runServerStartup(lifecycle: ServerLifecycle, steps: ReadonlyArray<StartupStage>): Promise<void> {
	try {
		for (const step of steps) {
			await lifecycle.runStartupStage(step)
			if (lifecycle.isShuttingDown()) throw new StartupInterruptedError()
		}
	} catch (startupError) {
		const reportedStartupError =
			lifecycle.isShuttingDown() && !(startupError instanceof StartupInterruptedError) ? new StartupInterruptedError() : startupError
		try {
			await lifecycle.shutdown()
		} catch (cleanupError) {
			const cleanupErrors = cleanupError instanceof ServerCleanupError ? cleanupError.orderedErrors : [cleanupError]
			throw new AggregateError([reportedStartupError, ...cleanupErrors], 'Server startup failed and cleanup failed', {
				cause: reportedStartupError,
			})
		}
		throw reportedStartupError
	}
}

export async function shutdownFromSignal(
	shutdown: () => Promise<void>,
	reportError: (message: string, error: unknown) => void = (message, error) => console.error(message, error),
	exit: (code: number) => void = (code) => process.exit(code),
): Promise<void> {
	let exitCode = 0
	try {
		await shutdown()
	} catch (error) {
		exitCode = 1
		reportError('Shutdown failed', error)
	} finally {
		exit(exitCode)
	}
}
