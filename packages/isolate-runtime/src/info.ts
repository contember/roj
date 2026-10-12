/** Read from this package's own package.json, so the value tracks releases. */

import pkg from '../package.json' with { type: 'json' }

export const ISOLATE_RUNTIME_VERSION = pkg.version as string
export const ISOLATE_RUNTIME_NAME = pkg.name as string
