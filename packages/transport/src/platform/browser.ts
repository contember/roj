/**
 * Browser WebSocket Adapter
 *
 * Wraps the native browser WebSocket to conform to IWebSocket interface.
 */

import type { ICloseEvent, IWebSocket, IWebSocketFactory } from './types.js'
import { WebSocketReadyState } from './types.js'

/**
 * Browser WebSocket adapter that wraps native WebSocket.
 */
class BrowserWebSocketAdapter implements IWebSocket {
	private readonly ws: WebSocket

	onopen: (() => void) | null = null
	onclose: ((event: ICloseEvent) => void) | null = null
	onerror: ((error: Error) => void) | null = null
	onmessage: ((data: string) => void) | null = null

	constructor(url: string) {
		this.ws = new WebSocket(url)

		this.ws.onopen = () => {
			this.onopen?.()
		}

		this.ws.onclose = (event) => {
			this.onclose?.({
				code: event.code,
				reason: event.reason,
			})
		}

		this.ws.onerror = () => {
			// Browser WebSocket doesn't provide error details
			this.onerror?.(new Error('WebSocket error'))
		}

		this.ws.onmessage = (event) => {
			// Handle text data only
			if (typeof event.data === 'string') {
				this.onmessage?.(event.data)
			} else if (event.data instanceof Blob) {
				// Convert Blob to string for text-only protocol
				event.data.text().then((text) => {
					this.onmessage?.(text)
				})
			}
		}
	}

	get readyState(): WebSocketReadyState {
		return this.ws.readyState as WebSocketReadyState
	}

	send(data: string): void {
		if (this.ws.readyState === WebSocketReadyState.OPEN) {
			this.ws.send(data)
		}
	}

	close(code?: number, reason?: string): void {
		this.ws.close(code, reason)
	}
}

/**
 * Browser WebSocket factory.
 */
export const browserWebSocketFactory: IWebSocketFactory = {
	create(url: string): IWebSocket {
		return new BrowserWebSocketAdapter(url)
	},
}

// Re-export types for convenience
export { WebSocketReadyState }
export type { ICloseEvent, IWebSocket, IWebSocketFactory }
