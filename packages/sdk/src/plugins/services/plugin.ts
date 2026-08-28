import z from 'zod/v4'
import { ValidationErrors } from '~/core/errors.js'
import { createEventsFactory } from '~/core/events/types.js'
import { definePlugin } from '~/core/plugins/plugin-builder.js'
import { sessionEvents } from '~/core/sessions/state.js'
import { createTool } from '~/core/tools/definition.js'
import { Err, Ok } from '~/lib/utils/result.js'
import type { PortPool } from './port-pool.js'
import { buildServiceStatusMessage } from './prompt.js'
import type { ServiceConfig, ServiceEntry } from './schema.js'
import type { ServicePidRegistry } from './pid-registry.js'
import { ServiceExecutor } from './service.js'
import type { RuntimeLeaseRelease } from '~/core/sessions/runtime-activity.js'

export const serviceEvents = createEventsFactory({
	events: {
		service_status_changed: z.object({
			serviceType: z.string(),
			toStatus: z.enum(['stopped', 'starting', 'ready', 'stopping', 'failed']),
			port: z.number().optional(),
			error: z.string().optional(),
			cwd: z.string().optional(),
			command: z.string().optional(),
			pid: z.number().optional(),
			pidStartTime: z.number().optional(),
			/**
			 * Who asked for the stop, on a `stopped` change. Absent from logs written
			 * before the discriminator existed — the reducer reads those as `agent`,
			 * the only default that cannot resurrect a service meant to stay down.
			 */
			stoppedBy: z.enum(['agent', 'eviction']).optional(),
			/**
			 * Set on a `failed` change when the `restartPolicy` has already queued a
			 * revival, so that no consumer — agent prompt, SPA, platform — mistakes it
			 * for a terminal failure. Cleared by the next status change.
			 */
			restartAt: z.number().optional(),
			restartAttempt: z.number().optional(),
			restartMaxRetries: z.number().optional(),
		}),
	},
})

export type ServiceStatusChangedEvent = (typeof serviceEvents)['Events']['service_status_changed']

/**
 * Session-wide service configuration.
 */
export interface ServicePluginConfig {
	services: ServiceConfig[]
	portPool: PortPool
	/** Durable pid record swept at agent boot. Absent for embedders without a data dir. */
	pidRegistry?: ServicePidRegistry
}

/**
 * Agent-specific service configuration.
 */
export interface ServiceAgentConfig {
	services: string[]
}

export const servicePlugin = definePlugin('services')
	.order(100)
	.pluginConfig<ServicePluginConfig>()
	.isSessionEnabled(({ pluginConfig }) => pluginConfig !== undefined && pluginConfig.services.length > 0)
	.events([serviceEvents, sessionEvents])
	.state({
		key: 'services',
		initial: (): Map<string, ServiceEntry> => new Map(),
		reduce: (services, event) => {
			switch (event.type) {
				case 'service_status_changed': {
					const newServices = new Map(services)
					const existing = newServices.get(event.serviceType)

					if (!existing && event.toStatus === 'starting') {
						newServices.set(event.serviceType, {
							serviceType: event.serviceType,
							status: event.toStatus,
							stoppedBy: 'never',
							port: event.port,
							cwd: event.cwd,
							command: event.command,
							startedAt: event.timestamp,
							pid: event.pid,
							pidStartTime: event.pidStartTime,
						})
					} else if (existing) {
						const updated: ServiceEntry = {
							...existing,
							status: event.toStatus,
							// A queued revival lives only until the next status change.
							restartAt: event.restartAt,
							restartAttempt: event.restartAttempt,
							restartMaxRetries: event.restartMaxRetries,
						}
						if (event.toStatus === 'starting') {
							updated.startedAt = event.timestamp
							updated.stoppedBy = 'never'
							updated.error = undefined
							updated.port = event.port
							updated.cwd = event.cwd
							updated.command = event.command
							updated.pid = event.pid
							updated.pidStartTime = event.pidStartTime
						}
						if (event.toStatus === 'ready') {
							updated.readyAt = event.timestamp
							if (event.port !== undefined) {
								updated.port = event.port
							}
							if (event.cwd !== undefined) {
								updated.cwd = event.cwd
							}
							if (event.command !== undefined) {
								updated.command = event.command
							}
						}
						if (event.toStatus === 'failed') {
							if (event.error) updated.error = event.error
							// `pid` is a claim on a process we spawned and have not seen exit — the
							// only handle a later boot has on it. A `failed` change carries it while
							// the process may still be alive, and omits it once the exit is confirmed.
							updated.pid = event.pid
							updated.pidStartTime = event.pidStartTime
						}
						if (event.toStatus === 'stopped') {
							updated.stoppedAt = event.timestamp
							updated.stoppedBy = event.stoppedBy ?? 'agent'
							updated.pid = undefined
							updated.pidStartTime = undefined
						}
						newServices.set(event.serviceType, updated)
					}

					return newServices
				}

				case 'session_restarted': {
					let changed = false
					const newServices = new Map(services)
					for (const [serviceType, entry] of services) {
						// `stopping` counts as live: a runtime that died mid-stop leaves it
						// behind and no other path ever clears it.
						const live = entry.status === 'starting' || entry.status === 'ready' || entry.status === 'stopping'
						// Any queued revival died with the runtime that held its timer.
						if (!live && entry.restartAt === undefined) continue

						const updated: ServiceEntry = {
							...entry,
							restartAt: undefined,
							restartAttempt: undefined,
							restartMaxRetries: undefined,
						}
						if (live) {
							updated.status = 'stopped'
							// The runtime died under it — nobody decided to stop it.
							updated.stoppedBy = 'eviction'
							updated.port = undefined
							updated.stoppedAt = event.timestamp
							// `pid` deliberately survives: nothing killed that process, and this is
							// the only handle left to find it with. This event is emitted immediately
							// before `onSessionReady`, whose reconcile is what reclaims it.
						}
						newServices.set(serviceType, updated)
						changed = true
					}
					return changed ? newServices : services
				}

				default:
					return services
			}
		},
	})
	.context(async (ctx, pluginConfig) => {
		const logger = ctx.logger
		const emitEvent = ctx.emitEvent
		const notify = ctx.notify
		const runtimeActivity = ctx.runtimeActivity
		interface ServiceLease {
			release: RuntimeLeaseRelease
			terminalPending: boolean
		}
		const serviceLeases = new Map<string, ServiceLease>()
		/** Status publications still in flight per type — a lease has to outlive them. */
		const pendingPublications = new Map<string, number>()
		const statusEffects = new Set<Promise<void>>()
		let statusEffectTail = Promise.resolve()
		let publicationEnabled = true
		const executor = new ServiceExecutor(logger, pluginConfig.portPool, {
			fs: ctx.platform.fs,
			process: ctx.platform.process,
			pidRegistry: pluginConfig.pidRegistry,
		})
		const beginLifecycle = (serviceType: string): ServiceLease | undefined => {
			const existing = serviceLeases.get(serviceType)
			if (existing && !existing.terminalPending) return existing

			// Undefined once the runtime unloads — the close tail that runs then is
			// already awaited by disposal, so nothing is left unguarded.
			const release = runtimeActivity.tryAcquire(`service:${serviceType}`)
			if (!release) return undefined
			const lease: ServiceLease = { release, terminalPending: false }
			serviceLeases.set(serviceType, lease)
			return lease
		}
		const releaseLease = (serviceType: string, lease: ServiceLease): void => {
			if (serviceLeases.get(serviceType) === lease) serviceLeases.delete(serviceType)
			lease.release()
		}
		/**
		 * A healthy service must not pin its runtime: eviction stops services and the
		 * rebuild starts them again, so a dev server sitting at `ready` for hours is
		 * exactly what eviction is for. Only work that cannot survive disposal keeps
		 * the lease — a transition in progress, a queued revival, an unpublished status.
		 */
		const needsRuntime = (serviceType: string): boolean => {
			if ((pendingPublications.get(serviceType) ?? 0) > 0) return true
			const status = executor.getStatus(serviceType)
			return status === 'starting' || status === 'stopping' || executor.hasScheduledRestart(serviceType)
		}
		const releaseLeaseWhenIdle = (serviceType: string, lease: ServiceLease): void => {
			if (serviceLeases.get(serviceType) !== lease || lease.terminalPending) return
			if (!needsRuntime(serviceType)) releaseLease(serviceType, lease)
		}
		const startService = async (
			config: ServiceConfig,
			sessionId: Parameters<ServiceExecutor['start']>[1],
			workspaceDir?: string,
			preferredPort?: number,
		) => {
			const lease = beginLifecycle(config.type)
			try {
				return await executor.start(config, sessionId, workspaceDir, preferredPort)
			} finally {
				if (lease) releaseLeaseWhenIdle(config.type, lease)
			}
		}
		const restartService = async (
			config: ServiceConfig,
			sessionId: Parameters<ServiceExecutor['restart']>[1],
			workspaceDir?: string,
			preferredPort?: number,
		) => {
			const lease = beginLifecycle(config.type)
			try {
				return await executor.restart(config, sessionId, workspaceDir, preferredPort)
			} finally {
				if (lease) releaseLeaseWhenIdle(config.type, lease)
			}
		}
		const waitForStatusEffects = async (): Promise<void> => {
			while (statusEffects.size > 0) {
				await Promise.allSettled([...statusEffects])
			}
		}
		executor.onStartSettled = (serviceType) => {
			const lease = serviceLeases.get(serviceType)
			if (lease) releaseLeaseWhenIdle(serviceType, lease)
		}
		executor.onStatusChanged = (sessionId, serviceType, status, details) => {
			if (!publicationEnabled) return
			const terminal = status === 'stopped' || (status === 'failed' && details.restartAt === undefined)
			const lease = terminal ? serviceLeases.get(serviceType) : beginLifecycle(serviceType)
			if (terminal && lease) lease.terminalPending = true
			pendingPublications.set(serviceType, (pendingPublications.get(serviceType) ?? 0) + 1)

			const effect = statusEffectTail.then(async () => {
				try {
					await emitEvent(serviceEvents.create('service_status_changed', {
						serviceType,
						toStatus: status,
						port: details.port,
						error: details.error,
						cwd: details.cwd,
						command: details.command,
						pid: details.pid,
						pidStartTime: details.pidStartTime,
						stoppedBy: details.stoppedBy,
						restartAt: details.restartAt,
						restartAttempt: details.restartAttempt,
						restartMaxRetries: details.restartMaxRetries,
					}))
					// Broadcast only after the durable projection catches up.
					notify('serviceStatus', {
						sessionId: String(sessionId),
						serviceType,
						status,
						port: details.port,
						restartAt: details.restartAt,
						restartAttempt: details.restartAttempt,
						restartMaxRetries: details.restartMaxRetries,
					})
				} catch (error) {
					logger.error('Failed to publish service status', error instanceof Error ? error : new Error(String(error)), {
						serviceType,
						status,
					})
				} finally {
					const remaining = (pendingPublications.get(serviceType) ?? 1) - 1
					if (remaining > 0) pendingPublications.set(serviceType, remaining)
					else pendingPublications.delete(serviceType)
					if (lease) {
						if (terminal) releaseLease(serviceType, lease)
						else releaseLeaseWhenIdle(serviceType, lease)
					}
				}
			})
			statusEffectTail = effect.then(() => undefined, () => undefined)
			statusEffects.add(effect)
			const removeEffect = () => statusEffects.delete(effect)
			void effect.then(removeEffect, removeEffect)
		}
		const close = async (
			sessionId: Parameters<ServiceExecutor['close']>[0],
			reason: Parameters<ServiceExecutor['close']>[1],
		): Promise<void> => {
			try {
				await executor.close(sessionId, reason)
			} finally {
				publicationEnabled = false
				executor.onStatusChanged = undefined
				executor.onStartSettled = undefined
				await waitForStatusEffects()
				for (const [serviceType, lease] of serviceLeases) releaseLease(serviceType, lease)
			}
		}
		return { executor, startService, restartService, close }
	})
	.agentConfig<ServiceAgentConfig>()
	.method('start', {
		input: z.object({
			serviceType: z.string().optional(),
			all: z.boolean().optional(),
			waitForReady: z.boolean().optional(),
		}),
		output: z.object({
			started: z.array(z.string()).optional(),
		}),
		handler: async (ctx, input) => {
			const serviceMap = new Map(ctx.pluginConfig.services.map((svc) => [svc.type, svc]))
			const started: string[] = []

			if (input.serviceType) {
				const svcConfig = serviceMap.get(input.serviceType)
				if (!svcConfig) return Err(ValidationErrors.invalid(`Service ${input.serviceType} not found`))

				const currentStatus = ctx.pluginContext.executor.getStatus(input.serviceType)
				if (currentStatus === 'starting' || currentStatus === 'ready') {
					return Ok({ started: [] })
				}

				const preferredPort = ctx.pluginState.get(input.serviceType)?.port
				const startResult = await ctx.pluginContext.startService(svcConfig, ctx.sessionId, ctx.sessionState.workspaceDir, preferredPort)
				if (!startResult.ok) return Err(ValidationErrors.invalid(startResult.error.message))
				started.push(input.serviceType)
			} else {
				for (const svcConfig of ctx.pluginConfig.services) {
					if (input.all || svcConfig.autoStart) {
						const status = ctx.pluginContext.executor.getStatus(svcConfig.type)
						if (status === 'ready' || status === 'starting') {
							// Re-notify for already running services (e.g. after reconnect)
							const entry = ctx.pluginState.get(svcConfig.type)
							if (entry?.port) {
								ctx.notify('serviceStatus', { sessionId: String(ctx.sessionId), serviceType: svcConfig.type, status, port: entry.port })
							}
						} else {
							const preferredPort = ctx.pluginState.get(svcConfig.type)?.port
							const startResult = await ctx.pluginContext.startService(svcConfig, ctx.sessionId, ctx.sessionState.workspaceDir, preferredPort)
							if (!startResult.ok) return Err(ValidationErrors.invalid(startResult.error.message))
							started.push(svcConfig.type)
						}
					}
				}
			}

			if (input.waitForReady && started.length > 0) {
				const results = await Promise.all(started.map((svc) => ctx.pluginContext.executor.waitForReady(svc)))
				const firstError = results.find((r) => !r.ok)
				if (firstError && !firstError.ok) {
					return Err(ValidationErrors.invalid(firstError.error.message))
				}
			}

			return Ok({ started: started.length > 0 ? started : undefined })
		},
	})
	.method('stop', {
		input: z.object({
			serviceType: z.string(),
		}),
		output: z.object({}),
		handler: async (ctx, input) => {
			const result = await ctx.pluginContext.executor.stop(input.serviceType, ctx.sessionId)
			if (!result.ok) return Err(ValidationErrors.invalid(result.error.message))
			return Ok({})
		},
	})
	.method('restart', {
		input: z.object({
			serviceType: z.string(),
		}),
		output: z.object({}),
		handler: async (ctx, input) => {
			const svcConfig = ctx.pluginConfig.services.find((s) => s.type === input.serviceType)
			if (!svcConfig) return Err(ValidationErrors.invalid(`Service ${input.serviceType} not found`))

			const preferredPort = ctx.pluginState.get(input.serviceType)?.port
			const result = await ctx.pluginContext.restartService(svcConfig, ctx.sessionId, ctx.sessionState.workspaceDir, preferredPort)
			if (!result.ok) return Err(ValidationErrors.invalid(result.error.message))
			return Ok({})
		},
	})
	.method('list', {
		input: z.object({}),
		output: z.object({
			services: z.array(z.object({
				serviceType: z.string(),
				status: z.string(),
				port: z.number().optional(),
			})),
		}),
		handler: async (ctx) => {
			const services = []
			for (const svcConfig of ctx.pluginConfig.services) {
				const status = ctx.pluginContext.executor.getStatus(svcConfig.type)
				const stateEntry = ctx.pluginState.get(svcConfig.type)
				services.push({
					serviceType: svcConfig.type,
					status: status ?? stateEntry?.status ?? 'stopped',
					port: stateEntry?.port,
				})
			}
			return Ok({ services })
		},
	})
	.method('status', {
		input: z.object({
			serviceType: z.string(),
			logLines: z.number().int().min(1).max(200).optional(),
		}),
		output: z.object({
			serviceType: z.string(),
			status: z.string(),
			port: z.number().optional(),
			cwd: z.string().optional(),
			command: z.string().optional(),
			error: z.string().optional(),
			recentLogs: z.array(z.string()),
		}),
		handler: async (ctx, input) => {
			const status = ctx.pluginContext.executor.getStatus(input.serviceType)
			const logsResult = ctx.pluginContext.executor.getLogs(input.serviceType, input.logLines ?? 10)
			const stateEntry = ctx.pluginState.get(input.serviceType)

			return Ok({
				serviceType: input.serviceType,
				status: status ?? 'stopped',
				port: stateEntry?.port,
				cwd: stateEntry?.cwd,
				command: stateEntry?.command,
				error: stateEntry?.error,
				recentLogs: logsResult.ok ? logsResult.value : [],
			})
		},
	})
	.method('logs', {
		input: z.object({
			serviceType: z.string(),
			lines: z.number().int().min(1).max(200).optional(),
		}),
		output: z.object({
			serviceType: z.string(),
			lines: z.array(z.string()),
		}),
		handler: async (ctx, input) => {
			const logsResult = ctx.pluginContext.executor.getLogs(input.serviceType, input.lines ?? 50)
			if (!logsResult.ok) return Err(ValidationErrors.invalid(logsResult.error.message))

			return Ok({
				serviceType: input.serviceType,
				lines: logsResult.value,
			})
		},
	})
	.sessionHook('onSessionReady', async (ctx) => {
		// Reconcile what a previous runtime left behind: kill orphaned process groups and
		// settle the entries that claimed them. Port is preserved in state so the next
		// start() reuses it via preferredPort. Also re-notify running services so DO
		// re-registers their URLs.
		//
		// Driven off the recorded pid rather than a list of running statuses: a process we
		// spawned and never saw exit is an orphan whatever the entry says, and `failed` or
		// `stopped` reaches the next boot still owning one just as often as `ready` does.
		for (const [serviceType, entry] of ctx.pluginState) {
			// `stopping` counts as live: a runtime that died mid-stop leaves it behind, and
			// it is reachable by no other recovery path.
			const live = entry.status === 'starting' || entry.status === 'ready' || entry.status === 'stopping'
			if (!live && entry.pid === undefined) continue

			const executorStatus = ctx.pluginContext.executor.getStatus(serviceType)
			if (executorStatus) {
				if (executorStatus === 'ready' && entry.port) {
					// Re-notify so DO can re-register service URL after reconnect
					ctx.notify('serviceStatus', { sessionId: String(ctx.sessionId), serviceType, status: 'ready', port: entry.port })
				}
				continue
			}

			if (entry.pid !== undefined) {
				// Guarded and loud when it fails: a signal that did not land must not look
				// like one that did.
				const reaped = await ctx.pluginContext.executor.reapProcessGroup(
					{ pid: entry.pid, pidStartTime: entry.pidStartTime },
					{ serviceType },
				)
				if (!reaped.ok) {
					ctx.logger.warn('Could not kill orphaned service process group', {
						serviceType,
						pid: entry.pid,
						error: reaped.error.message,
					})
				} else if (reaped.value === 'killed') {
					ctx.logger.info('Killed orphaned service process group', { serviceType, pid: entry.pid })
				}
			}

			// A `failed` entry keeps its status and the error that explains it — only its
			// claim on a process is taken away. Everything else settles as stopped.
			await ctx.emitEvent(serviceEvents.create('service_status_changed', entry.status === 'failed'
				? { serviceType, toStatus: 'failed' }
				: {
					serviceType,
					toStatus: 'stopped',
					// The runtime died under it — nobody decided to stop it, so autoStart may revive it.
					stoppedBy: 'eviction',
				}))
		}

		// Auto-start services configured with autoStart
		for (const svcConfig of ctx.pluginConfig.services) {
			if (!svcConfig.autoStart) continue
			const status = ctx.pluginContext.executor.getStatus(svcConfig.type)
			if (status === 'ready' || status === 'starting') continue

			// On a fresh runtime the executor knows nothing, so the persisted decision is
			// the only thing that can tell an evicted service (bring it back) from one the
			// agent stopped on purpose (leave it down).
			const entry = ctx.pluginState.get(svcConfig.type)
			if (entry?.status === 'stopped' && entry.stoppedBy === 'agent') {
				ctx.logger.debug('Auto-start skipped — the agent stopped this service', { serviceType: svcConfig.type })
				continue
			}

			const startResult = await ctx.pluginContext.startService(svcConfig, ctx.sessionId, ctx.sessionState.workspaceDir, entry?.port)
			if (!startResult.ok) {
				ctx.logger.debug('Auto-start service skipped', { serviceType: svcConfig.type, error: startResult.error.message })
			}
		}
	})
	.sessionHook('onSessionClose', async (ctx) => {
		await ctx.pluginContext.close(ctx.sessionId, ctx.reason)
	})
	.tools((ctx) => {
		const serviceMap = new Map(ctx.pluginConfig.services.map((svc) => [svc.type, svc]))
		const visibleServices = ctx.pluginAgentConfig?.services ?? []
		const visibleServiceTypes = visibleServices.filter((t) => serviceMap.has(t))
		if (visibleServiceTypes.length === 0) return []

		const serviceList = visibleServiceTypes.join(', ')

		return [
			createTool({
				name: 'service_start',
				description:
					`Start a stopped or failed session service. Only call this if the session context shows the service is not running — if it is already "ready", or marked as restarting automatically, you do not need to start it. Available services: ${serviceList}`,
				input: z.object({
					serviceType: z.string().describe('Service type identifier'),
				}),
				execute: async (input) => {
					if (!visibleServiceTypes.includes(input.serviceType)) {
						return Err({ message: `Service not visible: ${input.serviceType}`, recoverable: false })
					}

					const result = await ctx.self.start({
						serviceType: input.serviceType,
					})
					if (!result.ok) return Err({ message: result.error.message, recoverable: false })

					const readyResult = await ctx.pluginContext.executor.waitForReady(input.serviceType)
					if (!readyResult.ok) return Err(readyResult.error)

					return Ok(JSON.stringify({ status: 'ready', serviceType: input.serviceType }))
				},
			}),
			createTool({
				name: 'service_stop',
				description: `Stop a running session service. Available services: ${serviceList}`,
				input: z.object({
					serviceType: z.string().describe('Service type identifier'),
				}),
				execute: async (input) => {
					if (!visibleServiceTypes.includes(input.serviceType)) {
						return Err({ message: `Service not visible: ${input.serviceType}`, recoverable: false })
					}

					const result = await ctx.self.stop({
						serviceType: input.serviceType,
					})
					if (!result.ok) return Err({ message: result.error.message, recoverable: false })

					return Ok(JSON.stringify({ status: 'stopping', serviceType: input.serviceType }))
				},
			}),
			createTool({
				name: 'service_restart',
				description: `Restart a session service (stop + start). Available services: ${serviceList}`,
				input: z.object({
					serviceType: z.string().describe('Service type identifier'),
				}),
				execute: async (input) => {
					if (!visibleServiceTypes.includes(input.serviceType)) {
						return Err({ message: `Service not visible: ${input.serviceType}`, recoverable: false })
					}

					const result = await ctx.self.restart({
						serviceType: input.serviceType,
					})
					if (!result.ok) return Err({ message: result.error.message, recoverable: false })

					const readyResult = await ctx.pluginContext.executor.waitForReady(input.serviceType)
					if (!readyResult.ok) return Err(readyResult.error)

					return Ok(JSON.stringify({ status: 'ready', serviceType: input.serviceType }))
				},
			}),
			createTool({
				name: 'service_status',
				description:
					`Get the status of a session service including port, error, and recent log lines. Only call this to troubleshoot issues — if the session context already shows the service as "ready", you do not need to check status. Available services: ${serviceList}`,
				input: z.object({
					serviceType: z.string().describe('Service type identifier'),
					logLines: z.number().int().min(1).max(200).optional().describe('Number of recent log lines to include (default: 10)'),
				}),
				execute: async (input) => {
					if (!visibleServiceTypes.includes(input.serviceType)) {
						return Err({ message: `Service not visible: ${input.serviceType}`, recoverable: false })
					}

					const result = await ctx.self.status({
						serviceType: input.serviceType,
						logLines: input.logLines,
					})
					if (!result.ok) return Err({ message: result.error.message, recoverable: false })

					// Strip cwd: a real host path, meaningless (and misleading) inside
					// the agent's virtual-root namespace.
					const { cwd: _cwd, ...agentSafe } = result.value
					return Ok(JSON.stringify(agentSafe))
				},
			}),
			createTool({
				name: 'service_logs',
				description: `Get recent log output from a session service. Available services: ${serviceList}`,
				input: z.object({
					serviceType: z.string().describe('Service type identifier'),
					lines: z.number().int().min(1).max(200).optional().describe('Number of log lines to return (default: 50)'),
				}),
				execute: async (input) => {
					if (!visibleServiceTypes.includes(input.serviceType)) {
						return Err({ message: `Service not visible: ${input.serviceType}`, recoverable: false })
					}

					const result = await ctx.self.logs({
						serviceType: input.serviceType,
						lines: input.lines,
					})
					if (!result.ok) return Err({ message: result.error.message, recoverable: false })

					return Ok(JSON.stringify(result.value))
				},
			}),
		]
	})
	.status((ctx) => {
		const serviceMap = new Map(ctx.pluginConfig.services.map((svc) => [svc.type, svc]))
		const visibleServices = ctx.pluginAgentConfig?.services ?? []
		const visibleServiceTypes = visibleServices.filter((t) => serviceMap.has(t))
		if (visibleServiceTypes.length === 0) return null

		const services = Array.from(ctx.pluginState.values()).filter((s) => visibleServiceTypes.includes(s.serviceType))
		const configs = Array.from(serviceMap.values()).filter((c) => visibleServiceTypes.includes(c.type))

		return buildServiceStatusMessage(services, configs)
	})
	.build()
