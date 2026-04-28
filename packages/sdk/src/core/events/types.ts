import z4 from 'zod/v4'
import { SessionId } from '~/core/sessions/schema'

declare const __brand: unique symbol
type TheBrand<B> = { [__brand]: B }
type Brand<T, B> = T & TheBrand<B>

export type BaseEvent<T extends string> = Brand<{
	sessionId: SessionId
	timestamp: number
	type: T
}, 'Event'>

export type EventsMap = Record<string, z4.ZodObject<z4.ZodRawShape>>

export type EventUnion<TEvents extends EventsMap> = {
	[K in keyof TEvents & string]: BaseEvent<K> & z4.infer<TEvents[K]>
}[keyof TEvents & string]

type EventsOf<TEvents extends EventsMap> = {
	[K in keyof TEvents & string]: BaseEvent<K> & z4.infer<TEvents[K]>
}

export interface EventsFactory<TEvents extends EventsMap> {
	create<K extends keyof TEvents & string>(type: K, input: z4.infer<TEvents[K]>): Omit<BaseEvent<K>, 'sessionId'> & z4.infer<TEvents[K]>
	EventType: EventUnion<TEvents>
	Events: EventsOf<TEvents>
}

/**
 * Extract the event union type from an EventsFactory instance.
 * Usage: FactoryEventType<typeof sessionEvents | typeof agentEvents>
 */
export type FactoryEventType<F extends { EventType: unknown }> = F['EventType'] & BaseEvent<string>

/**
 * Generic domain event type — any event with sessionId, timestamp, and type.
 * Replaces the monolithic DomainEvent union from events.ts.
 * Individual reducers use their own narrower event types via EventsFactory.
 */
export type DomainEvent = BaseEvent<string>

/**
 * Type guard to check if an unknown value is a DomainEvent.
 */
export const isDomainEvent = (event: unknown): event is DomainEvent =>
	typeof event === 'object'
	&& event !== null
	&& 'type' in event
	&& 'sessionId' in event
	&& 'timestamp' in event

export const createEventsFactory = <TEvents extends EventsMap>(_args: { events: TEvents }): EventsFactory<TEvents> => {
	return {
		create: (type, input) => ({
			type,
			...input,
			...({} as TheBrand<'Event'>),
			timestamp: Date.now(),
		}),
		EventType: undefined!,
		Events: undefined!,
	}
}
