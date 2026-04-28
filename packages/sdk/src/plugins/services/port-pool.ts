/**
 * PortPool - Manages port allocation from a global range.
 *
 * Ports are assigned from the upper registered range (10000–49151) to avoid
 * common dev server defaults and OS ephemeral ports. Allocation is random
 * to minimize predictable conflicts across sessions.
 */

export class PortPool {
	private readonly allocated = new Set<number>()

	constructor(
		private readonly minPort = 10000,
		private readonly maxPort = 49151,
	) {}

	/**
	 * Try to allocate a specific (preferred) port.
	 * Returns true if the port was available and is now allocated.
	 */
	tryAllocate(port: number): boolean {
		if (port < this.minPort || port > this.maxPort) return false
		if (this.allocated.has(port)) return false
		this.allocated.add(port)
		return true
	}

	/**
	 * Allocate a random available port from the range.
	 * Returns null if the pool is exhausted (practically impossible).
	 */
	allocate(): number | null {
		const range = this.maxPort - this.minPort + 1
		if (this.allocated.size >= range) return null

		// Random probe — fast for sparse pools
		const maxAttempts = 100
		for (let i = 0; i < maxAttempts; i++) {
			const port = this.minPort + Math.floor(Math.random() * range)
			if (!this.allocated.has(port)) {
				this.allocated.add(port)
				return port
			}
		}

		// Fallback: linear scan (only if pool is very dense)
		for (let port = this.minPort; port <= this.maxPort; port++) {
			if (!this.allocated.has(port)) {
				this.allocated.add(port)
				return port
			}
		}

		return null
	}

	/**
	 * Allocate preferred port if available, otherwise allocate a random port.
	 */
	allocatePreferred(preferred: number | undefined): number | null {
		if (preferred !== undefined && this.tryAllocate(preferred)) {
			return preferred
		}
		return this.allocate()
	}

	/**
	 * Release a previously allocated port back to the pool.
	 */
	release(port: number): void {
		this.allocated.delete(port)
	}
}
