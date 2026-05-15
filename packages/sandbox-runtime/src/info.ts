/**
 * Build-time runtime metadata. Read from this package's own package.json so
 * the value tracks releases automatically — no risk of a forgotten string
 * update after a version bump.
 */

import pkg from '../package.json' with { type: 'json' }

export const SANDBOX_RUNTIME_VERSION = pkg.version as string
export const SANDBOX_RUNTIME_NAME = pkg.name as string
