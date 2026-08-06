/**
 * Result type for explicit error handling without exceptions.
 *
 * Re-exported from @roj-ai/transport, which owns the definition — sdk already
 * depends on it, and three byte-identical copies (here, transport, shared) meant
 * any addition to the vocabulary had to be written three times or silently
 * diverge. The ~58 in-package importers keep using `~/lib/utils/result.js`.
 */

export type { Result } from '@roj-ai/transport'
export { Err, flatMapResult, isErr, isOk, mapResult, Ok, unwrapOr, unwrapOrThrow } from '@roj-ai/transport'
