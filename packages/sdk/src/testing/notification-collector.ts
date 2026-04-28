import type { PluginNotification } from '~/core/plugins/plugin-builder.js'

/**
 * In-memory notification collector for testing.
 * Captures PluginNotification instances emitted during session execution.
 */
export class NotificationCollector {
	private notifications: PluginNotification[] = []
	private waiters: Array<{
		predicate: (n: PluginNotification) => boolean
		resolve: (n: PluginNotification) => void
		reject: (err: Error) => void
		timer: ReturnType<typeof setTimeout>
	}> = []

	/**
	 * Push a notification into the collector.
	 * Wired to SessionManager's onUserOutput callback.
	 */
	push(notification: PluginNotification): void {
		this.notifications.push(notification)

		// Check waiters
		for (let i = this.waiters.length - 1; i >= 0; i--) {
			const waiter = this.waiters[i]
			if (waiter.predicate(notification)) {
				clearTimeout(waiter.timer)
				this.waiters.splice(i, 1)
				waiter.resolve(notification)
			}
		}
	}

	/**
	 * Get all collected notifications.
	 */
	getAll(): PluginNotification[] {
		return [...this.notifications]
	}

	/**
	 * Get notifications from a specific plugin.
	 */
	getByPlugin(pluginName: string): PluginNotification[] {
		return this.notifications.filter((n) => n.pluginName === pluginName)
	}

	/**
	 * Get notifications matching plugin name and type.
	 */
	getByType(pluginName: string, type: string): PluginNotification[] {
		return this.notifications.filter((n) => n.pluginName === pluginName && n.type === type)
	}

	/**
	 * Get agent messages (user-chat.agentMessage notifications) with extracted payload.
	 */
	getAgentMessages(): Array<{ content: string; format: string; sessionId: string }> {
		return this.getByType('user-chat', 'agentMessage').map((n) => {
			const payload = n.payload as { content: string; format: string; sessionId: string }
			return {
				content: payload.content,
				format: payload.format,
				sessionId: payload.sessionId,
			}
		})
	}

	/**
	 * Wait for a notification matching the predicate.
	 * Checks already-collected notifications first, then waits for new ones.
	 */
	waitFor(
		predicate: (n: PluginNotification) => boolean,
		opts?: { timeoutMs?: number },
	): Promise<PluginNotification> {
		// Check already-collected
		const existing = this.notifications.find(predicate)
		if (existing) return Promise.resolve(existing)

		const timeoutMs = opts?.timeoutMs ?? 5000

		return new Promise<PluginNotification>((resolve, reject) => {
			const timer = setTimeout(() => {
				const idx = this.waiters.findIndex((w) => w.resolve === resolve)
				if (idx !== -1) this.waiters.splice(idx, 1)
				reject(new Error(`waitFor timed out after ${timeoutMs}ms`))
			}, timeoutMs)

			this.waiters.push({ predicate, resolve, reject, timer })
		})
	}

	/**
	 * Clear all collected notifications.
	 */
	clear(): void {
		this.notifications = []
	}
}
