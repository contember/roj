/**
 * RingBuffer - Circular buffer for log lines.
 *
 * Fixed-size buffer that overwrites oldest entries when full.
 */
export class RingBuffer {
	private readonly buffer: string[]
	private readonly capacity: number
	private head = 0
	private count = 0

	constructor(capacity: number) {
		this.capacity = capacity
		this.buffer = new Array(capacity)
	}

	/**
	 * Push a line into the buffer. Overwrites oldest if full.
	 */
	push(line: string): void {
		this.buffer[this.head] = line
		this.head = (this.head + 1) % this.capacity
		if (this.count < this.capacity) {
			this.count++
		}
	}

	/**
	 * Return all lines in order (oldest first).
	 */
	toArray(): string[] {
		if (this.count < this.capacity) {
			return this.buffer.slice(0, this.count)
		}
		// Buffer is full: head points to the oldest entry
		return [
			...this.buffer.slice(this.head, this.capacity),
			...this.buffer.slice(0, this.head),
		]
	}

	/**
	 * Return the last N lines (most recent).
	 */
	last(n: number): string[] {
		const all = this.toArray()
		if (n >= all.length) return all
		return all.slice(all.length - n)
	}

	/**
	 * Clear the buffer.
	 */
	clear(): void {
		this.head = 0
		this.count = 0
	}

	/**
	 * Current number of lines in the buffer.
	 */
	get size(): number {
		return this.count
	}
}
