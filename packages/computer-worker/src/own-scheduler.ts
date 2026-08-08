/**
 * Services for code that builds its own SessionManager.
 *
 * The DO's `alarm()` dispatches wakes into the one SessionManager it booted. A
 * manager a probe or benchmark makes for itself is invisible to that dispatch,
 * so its agents would wait on wakes nobody delivers — and a wake for a session
 * the DO's manager *can* load would make it load a second copy of it.
 *
 * Such a manager lives only for the request that built it, which is the case
 * `LiveScheduler` exists for, so it drives its own timers instead.
 */

import type { Services } from '@roj-ai/sdk'
import { createTimerScheduler } from '@roj-ai/sdk/platform'

export function withOwnScheduler(services: Services<'isolate'>): Services<'isolate'> {
	return { ...services, platform: { ...services.platform, scheduler: createTimerScheduler() } }
}
