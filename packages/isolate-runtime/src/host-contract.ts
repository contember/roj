/**
 * The contract between the runtime and the Durable Object hosting it. Kept free of imports,
 * so a host type-checked against Workers types can use it without the SDK.
 */

/** A user-output notification in the shape the sandbox runtime sends over its agent WebSocket. */
export interface RuntimeBroadcast {
	type: string
	payload: unknown
	ts: number
}

/** What the host gives the runtime. Bound to one instance by the host; the runtime cannot name another. */
export interface RuntimeHost {
	/** The single alarm slot of the host's Durable Object, lent to the runtime. */
	setAlarm(scheduledTime: number): Promise<void>
	deleteAlarm(): Promise<void>
	broadcast(message: RuntimeBroadcast): Promise<void>
}

/** What the host calls on the facet's stub. */
export interface RuntimeFacetRpc {
	fetch(request: Request): Promise<Response>
	deliverWakes(): Promise<string[]>
}
