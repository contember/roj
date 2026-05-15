/**
 * Build-time SDK metadata. Read from this package's own package.json so the
 * value tracks releases automatically — no risk of a forgotten string update
 * after a version bump.
 */

import pkg from '../package.json' with { type: 'json' }

export const SDK_VERSION = pkg.version as string
