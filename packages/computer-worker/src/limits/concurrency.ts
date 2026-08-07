/** Placeholder — replaced by the concurrency probe. */

import type { LimitProbe } from './context.js'

export const concurrencyProbe: LimitProbe = async () => ({ todo: 'concurrency' })
