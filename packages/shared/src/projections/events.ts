/**
 * ProjectionEvent — union of all event types handled by shared projections.
 *
 * Boundary code (event-store.ts, debug.ts) casts DomainEvent → ProjectionEvent once.
 * Individual projection reducers accept ProjectionEvent directly — no internal casts.
 */

import type { BuiltinEvent, ServiceStatusChangedEvent, SkillLoadedEvent } from '@roj-ai/sdk'

export type ProjectionEvent = BuiltinEvent | SkillLoadedEvent | ServiceStatusChangedEvent
