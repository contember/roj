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
import { getProcessStartTime, ServiceExecutor } from './service.js'

export const serviceEvents = createEventsFactory({
	events: {
		service_status_changed: z.object({
			serviceType: z.string(),
			toStatus: z.enum(['stopped', 'starting', 'ready', 'stopping', 'failed', 'paused']),
			port: z.number().optional(),
			error: z.string().optional(),
			pid: z.number().optional(),
			pidStartTime: z.number().optional(),
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
}

/**
 * Agent-specific service configuration.
 */
export interface ServiceAgentConfig {
	services: string[]
}

export const servicePlugin = definePlugin('services')
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
							port: event.port,
							startedAt: event.timestamp,
							pid: event.pid,
							pidStartTime: event.pidStartTime,
						})
					} else if (existing) {
						const updated: ServiceEntry = {
							...existing,
							status: event.toStatus,
						}
						if (event.toStatus === 'starting') {
							updated.startedAt = event.timestamp
							updated.error = undefined
							updated.port = event.port
							updated.pid = event.pid
							updated.pidStartTime = event.pidStartTime
						}
						if (event.toStatus === 'ready') {
							updated.readyAt = event.timestamp
							if (event.port !== undefined) {
								updated.port = event.port
							}
						}
						if (event.toStatus === 'failed' && event.error) {
							updated.error = event.error
							updated.pid = undefined
							updated.pidStartTime = undefined
						}
						if (event.toStatus === 'stopped') {
							updated.stoppedAt = event.timestamp
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
						if (entry.status === 'starting' || entry.status === 'ready') {
							newServices.set(serviceType, {
								...entry,
								status: 'stopped',
								port: undefined,
								pid: undefined,
								pidStartTime: undefined,
								stoppedAt: event.timestamp,
							})
							changed = true
						}
					}
					return changed ? newServices : services
				}

				default:
					return services
			}
		},
	})
	.context(async (ctx, pluginConfig) => {
		const executor = new ServiceExecutor(ctx.logger, pluginConfig.portPool, { fs: ctx.platform.fs, process: ctx.platform.process })
		executor.onStatusChanged = (sessionId, serviceType, status, port, error, pid, pidStartTime) => {
			void ctx.emitEvent(serviceEvents.create('service_status_changed', {
				serviceType,
				toStatus: status,
				port,
				error,
				pid,
				pidStartTime,
			}))
			// Broadcast service status to connected clients (DO → SPA) via WS
			ctx.notify('serviceStatus', { sessionId: String(sessionId), serviceType, status, port })
		}
		return { executor }
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
				await ctx.pluginContext.executor.start(svcConfig, ctx.sessionId, ctx.sessionState.workspaceDir, preferredPort)
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
							await ctx.pluginContext.executor.start(svcConfig, ctx.sessionId, ctx.sessionState.workspaceDir, preferredPort)
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
			const result = await ctx.pluginContext.executor.restart(svcConfig, ctx.sessionId, ctx.sessionState.workspaceDir, preferredPort)
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
		// Reconcile: kill orphaned process groups from previous server instance
		// and mark corresponding services as stopped. Port is preserved in state
		// so the next start() reuses it via preferredPort.
		// Also re-notify running services so DO re-registers their URLs.
		for (const [serviceType, entry] of ctx.pluginState) {
			if (entry.status === 'starting' || entry.status === 'ready' || entry.status === 'paused') {
				const executorStatus = ctx.pluginContext.executor.getStatus(serviceType)
				if (!executorStatus) {
					if (entry.pid !== undefined) {
						// PID-reuse guard: only kill if we can confirm this PID still
						// belongs to the process we spawned. If we stored a pidStartTime,
						// the current start time must match — a mismatch means the kernel
						// recycled the PID for an unrelated process and SIGKILL would be
						// disastrous. On non-Linux (no /proc), start times are always
						// undefined and we fall back to the pre-existing kill-and-hope path.
						const currentStartTime = await getProcessStartTime(ctx.platform.fs, entry.pid)
						const pidReused = entry.pidStartTime !== undefined
							&& currentStartTime !== undefined
							&& currentStartTime !== entry.pidStartTime

						if (pidReused) {
							ctx.logger.warn('PID reuse detected during orphan reconcile — refusing to kill', {
								serviceType,
								pid: entry.pid,
								storedStartTime: entry.pidStartTime,
								currentStartTime,
							})
						} else {
							try {
								process.kill(-entry.pid, 'SIGKILL')
								ctx.logger.info('Killed orphaned service process group', { serviceType, pid: entry.pid })
							} catch (err) {
								ctx.logger.debug('Orphaned service process already gone', { serviceType, pid: entry.pid, err })
							}
						}
					}
					await ctx.emitEvent(serviceEvents.create('service_status_changed', {
						serviceType,
						toStatus: 'stopped',
					}))
				} else if (executorStatus === 'ready' && entry.port) {
					// Re-notify so DO can re-register service URL after reconnect
					ctx.notify('serviceStatus', { sessionId: String(ctx.sessionId), serviceType, status: 'ready', port: entry.port })
				}
			}
		}

		// Auto-start services configured with autoStart
		for (const svcConfig of ctx.pluginConfig.services) {
			if (svcConfig.autoStart) {
				const status = ctx.pluginContext.executor.getStatus(svcConfig.type)
				if (status !== 'ready' && status !== 'starting') {
					const preferredPort = ctx.pluginState.get(svcConfig.type)?.port
					await ctx.pluginContext.executor.start(svcConfig, ctx.sessionId, ctx.sessionState.workspaceDir, preferredPort)
				}
			}
		}
	})
	.sessionHook('onSessionClose', async (ctx) => {
		for (const svcConfig of ctx.pluginConfig.services) {
			const status = ctx.pluginContext.executor.getStatus(svcConfig.type)
			if (status === 'ready' || status === 'starting') {
				await ctx.pluginContext.executor.stop(svcConfig.type, ctx.sessionId)
			}
		}
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
					`Start a stopped or failed session service. Only call this if the session context shows the service is not running — if it is already "ready", you do not need to start it. Available services: ${serviceList}`,
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

					return Ok(JSON.stringify(result.value))
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
