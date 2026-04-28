import type { DomainEvent } from '~/core/events/types.js'
import type { BaseEvent } from '~/core/events/types.js'
import type { SessionState } from './state.js'

// ============================================================================
// Session reducer types
// ============================================================================

export type SessionReducer = (state: SessionState, event: DomainEvent) => SessionState

/**
 * Structural supertype for any EventsFactory — used to infer event types from factories.
 */
type EventSourceRef = {
	create(type: string, input: unknown): unknown
	EventType: unknown
	Events: unknown
}

// ============================================================================
// State slice
// ============================================================================

export interface StateSlice<TKey extends string = string, TState = unknown> {
	key: TKey
	initialState: () => TState
	select: (state: SessionState) => TState
	reducer: SessionReducer
}

/**
 * Create a typed state slice that owns a specific key on SessionState.
 *
 * Each slice stores its state under a dynamic key on SessionState.
 * Use `selectPluginState()` to read plugin state from outside the plugin.
 *
 * The `events` field declares which EventsFactory instances this reducer depends on.
 * The event type for `apply` is inferred from the factories — use a switch on
 * `event.type` for TypeScript narrowing.
 */
export function createStateSlice<TKey extends string, TState, const TFactories extends readonly EventSourceRef[]>(config: {
	key: TKey
	events: TFactories
	initialState: () => TState
	apply: (state: TState, event: TFactories[number]['EventType'] & BaseEvent<string>, sessionState: SessionState) => TState
}): StateSlice<TKey, TState> {
	// Dynamic key access requires Record cast — plugin keys are added via module augmentation
	// but TypeScript can't correlate the generic TKey with augmented properties
	const stateRecord = (state: SessionState) => state as unknown as Record<string, unknown>
	return {
		key: config.key,
		initialState: config.initialState,
		select: (state) => stateRecord(state)[config.key] as TState,
		reducer: (state, event) => {
			const record = stateRecord(state)
			const keyExists = config.key in record
			const sliceState = keyExists
				? record[config.key] as TState
				: config.initialState()
			const newSliceState = config.apply(sliceState, event as TFactories[number]['EventType'] & BaseEvent<string>, state)
			// Only skip update when key already exists and value is unchanged
			if (keyExists && newSliceState === sliceState) return state
			return { ...state, [config.key]: newSliceState }
		},
	}
}

/**
 * Create a typed session reducer that narrows DomainEvent to the union of events
 * from the provided factories. Same casting pattern as createStateSlice.
 */
export function createTypedReducer<const TFactories extends readonly EventSourceRef[]>(
	events: TFactories,
	apply: (state: SessionState, event: TFactories[number]['EventType'] & BaseEvent<string>) => SessionState,
): SessionReducer {
	return (state, event) => apply(state, event as TFactories[number]['EventType'] & BaseEvent<string>)
}

// ============================================================================
// Reducer composition
// ============================================================================

/**
 * Read a plugin-owned state slice from SessionState by dynamic key.
 *
 * Plugin state is stored under dynamic keys (e.g. 'todos', 'workers') that are
 * not part of the core SessionState interface. This helper performs the same
 * dynamic record access that createStateSlice uses internally.
 */
export function selectPluginState<TState>(state: SessionState, key: string): TState | undefined {
	const record = state as unknown as Record<string, unknown>
	return record[key] as TState | undefined
}

export const composeReducers = (...reducers: SessionReducer[]): SessionReducer => (state, event) => reducers.reduce((s, r) => r(s, event), state)
