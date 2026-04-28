/**
 * Message Router
 *
 * Handles notification dispatching - no request-response, no correlation.
 * Simplified for notification-only protocols.
 */

import type { HandlerContext, InferInput, Protocol, ProtocolDef, ProtocolHandlers } from './protocol.js'
import type { WireMessage } from './types.js'

// ============================================================================
// Router Types
// ============================================================================

/**
 * Message send function type.
 */
export type MessageSender = (message: string) => boolean

/**
 * Router error types for debugging protocol issues.
 */
export type RouterErrorType = 'parse' | 'unknown_type' | 'validation' | 'handler'

/**
 * Router error handler callback.
 */
export type RouterErrorHandler = (error: {
	type: RouterErrorType
	message: string
	raw?: string
	details?: unknown
}) => void

// ============================================================================
// Message Router
// ============================================================================

/**
 * Message router for handling incoming notifications and sending outbound notifications.
 *
 * Simplified notification-only router:
 * - No request-response correlation
 * - No pending requests tracking
 * - Fire-and-forget notifications only
 */
/**
 * Raw message listener — receives every parsed message before handler dispatch.
 */
export type RawMessageListener = (type: string, payload: unknown) => void

export class MessageRouter<TReceive extends ProtocolDef, TSend extends ProtocolDef> {
	private readonly receiveProtocol: Protocol<TReceive> | null
	private readonly sendProtocol: Protocol<TSend> | null

	private handlers: Partial<ProtocolHandlers<TReceive>> = {}
	private sender: MessageSender | null = null
	private errorHandler: RouterErrorHandler | null = null
	private rawMessageListener: RawMessageListener | null = null

	constructor(
		receiveProtocol: Protocol<TReceive> | null,
		sendProtocol: Protocol<TSend> | null,
	) {
		this.receiveProtocol = receiveProtocol
		this.sendProtocol = sendProtocol
	}

	/**
	 * Set the message sender function.
	 */
	setSender(sender: MessageSender): void {
		this.sender = sender
	}

	/**
	 * Set handlers for incoming notifications.
	 */
	setHandlers(handlers: Partial<ProtocolHandlers<TReceive>>): void {
		this.handlers = handlers
	}

	/**
	 * Set error handler for debugging protocol issues.
	 */
	setErrorHandler(handler: RouterErrorHandler): void {
		this.errorHandler = handler
	}

	/**
	 * Set a raw message listener that receives every incoming message.
	 * When set, bypasses per-type handler dispatch — the listener receives (type, payload) directly.
	 */
	setRawMessageListener(listener: RawMessageListener): void {
		this.rawMessageListener = listener
	}

	/**
	 * Handle an incoming raw message (notification).
	 */
	async handleMessage(raw: string, ctx: HandlerContext): Promise<void> {
		let parsed: WireMessage
		try {
			parsed = JSON.parse(raw)
		} catch (e) {
			this.errorHandler?.({ type: 'parse', message: 'Invalid JSON', raw, details: e })
			return
		}

		const { type, payload } = parsed

		// Raw listener mode — forward everything without dispatch or validation
		if (this.rawMessageListener) {
			this.rawMessageListener(type, payload)
			return
		}

		if (this.receiveProtocol) {
			// Validated path — protocol provided, validate input before dispatching
			const endpoint = this.receiveProtocol._def[type]
			if (!endpoint) {
				this.errorHandler?.({ type: 'unknown_type', message: `Unknown message type: ${type}`, raw })
				return
			}

			const inputResult = this.receiveProtocol.validateInput(type, payload)
			if (!inputResult.success) {
				this.errorHandler?.({ type: 'validation', message: `Validation failed for ${type}`, raw, details: inputResult.error })
				return
			}

			const handler = this.handlers[type]
			if (!handler) return

			try {
				await (handler as (input: unknown, ctx: HandlerContext) => Promise<void>)(inputResult.data, ctx)
			} catch (e) {
				this.errorHandler?.({ type: 'handler', message: `Handler error for ${type}`, raw, details: e })
			}
		} else {
			// Unvalidated path — no protocol, dispatch directly (trusted source)
			const handler = this.handlers[type]
			if (!handler) return

			try {
				await (handler as (input: unknown, ctx: HandlerContext) => Promise<void>)(payload, ctx)
			} catch (e) {
				this.errorHandler?.({ type: 'handler', message: `Handler error for ${type}`, raw, details: e })
			}
		}
	}

	/**
	 * Send a notification (fire-and-forget).
	 */
	notify<K extends keyof TSend>(
		name: K,
		input: TSend[K] extends { input: infer I } ? (I extends { _type: string } ? never : InferInput<TSend[K]>) : never,
	): boolean {
		if (!this.sender) {
			return false
		}

		const message: WireMessage = {
			type: String(name),
			payload: input,
			ts: Date.now(),
		}

		return this.sender(JSON.stringify(message))
	}
}

// ============================================================================
// Router Builder
// ============================================================================

/**
 * Create a message router for the given protocols.
 */
export function createRouter<TReceive extends ProtocolDef, TSend extends ProtocolDef>(
	receiveProtocol: Protocol<TReceive> | null,
	sendProtocol: Protocol<TSend> | null,
): MessageRouter<TReceive, TSend> {
	return new MessageRouter(receiveProtocol, sendProtocol)
}
