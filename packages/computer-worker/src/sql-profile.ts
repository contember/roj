/**
 * Which statements an operation actually runs against the workspace database.
 *
 * Modelling this got the last round wrong: a cost per statement was measured on
 * one trivial lookup and then assumed to hold for every other shape, which it
 * does not. So nothing is assumed here — the database's own methods are wrapped
 * for the duration of one call and every statement is counted under the text
 * that produced it.
 *
 * Counts only, no per-call timing: workerd freezes its clock between I/O, and
 * these calls are synchronous, so a timer around one of them reads zero. The
 * wall clock for the whole operation is taken outside, and the split between
 * shapes comes from the counts.
 */

/** The slice of `Workspace['db']` this replaces while profiling. */
interface ProfilableDb {
	one(query: string, ...bindings: unknown[]): unknown
	all(query: string, ...bindings: unknown[]): unknown[]
	run(query: string, ...bindings: unknown[]): void
	scalar(query: string, ...bindings: unknown[]): unknown
}

const METHODS = ['one', 'all', 'run', 'scalar'] as const

type Method = (typeof METHODS)[number]

export interface SqlCaller {
	/** Frames above the driver, innermost first. */
	frames: string[]
	/** Sampled calls down this path, scaled back to the full count. */
	calls: number
}

export interface SqlShape {
	/** Statement text, whitespace collapsed and truncated. */
	query: string
	calls: number
	/** Rows handed back, summed — only `all` returns more than one. */
	rows: number
	/** Where the calls came from. A count alone does not say who to fix. */
	callers?: SqlCaller[]
}

export interface SqlProfile {
	totalCalls: number
	totalRows: number
	/** Wall clock for the profiled call, so calls can be read against it. */
	wallMs: number
	/** Statement shapes, most-called first. */
	shapes: SqlShape[]
}

const MAX_QUERY_CHARS = 150
const MAX_SHAPES = 15
/** One stack in this many calls: enough shape, not enough cost to move the wall clock. */
const SAMPLE_EVERY = 8
const MAX_CALLERS = 6
const MAX_FRAMES = 14
/** The wrappers below sit between the caller and the statement; bundled, they share a filename. */
const OWN_FRAMES = /^(record|Database\.wrapped)\b/

function normalize(query: string): string {
	const collapsed = query.replace(/\s+/g, ' ').trim()
	return collapsed.length > MAX_QUERY_CHARS ? `${collapsed.slice(0, MAX_QUERY_CHARS)}…` : collapsed
}

/** V8 stack lines to the frames worth reading: drop the profiler's own. */
function framesAbove(stack: string | undefined): string[] {
	if (stack === undefined) return []
	const frames: string[] = []
	for (const line of stack.split('\n')) {
		const trimmed = line.trim()
		if (!trimmed.startsWith('at ')) continue
		const frame = trimmed.slice(3)
		if (OWN_FRAMES.test(frame)) continue
		frames.push(frame.replace(/ \(.*[/\\]([^/\\]+:\d+):\d+\)$/, ' ($1)'))
		if (frames.length === MAX_FRAMES) break
	}
	return frames
}

/**
 * Run `work` with every statement on `db` counted.
 *
 * The wrappers are installed as own properties over the prototype's methods and
 * deleted afterwards, so the object is the same one the provider already holds
 * and nothing needs to be threaded through the workspace.
 */
export async function profileSql<T>(db: ProfilableDb, work: () => Promise<T>): Promise<{ result: T; profile: SqlProfile }> {
	const counts = new Map<string, SqlShape>()
	const target: Record<string, unknown> = db as unknown as Record<string, unknown>
	// The methods live on the prototype, so restoring means removing the own
	// property again — unless one was already there, which is put back verbatim.
	const owned = new Map<Method, { had: boolean; value: unknown }>()

	/** shape key -> joined frames -> sampled calls. */
	const callers = new Map<string, Map<string, number>>()

	const record = (query: string, rows: number): void => {
		const key = normalize(query)
		const shape = counts.get(key)
		if (shape === undefined) counts.set(key, { query: key, calls: 1, rows })
		else {
			shape.calls++
			shape.rows += rows
		}
		const calls = counts.get(key)?.calls ?? 1
		if (calls % SAMPLE_EVERY !== 1) return
		const frames = framesAbove(new Error().stack).join('\n')
		const perShape = callers.get(key) ?? new Map<string, number>()
		perShape.set(frames, (perShape.get(frames) ?? 0) + 1)
		callers.set(key, perShape)
	}

	// `scalar` calls `one` calls `all`, and all three are wrapped, so one
	// statement would be recorded up to three times. Only the call the caller
	// actually made counts; the methods are synchronous, so a depth suffices.
	let depth = 0

	for (const method of METHODS) {
		const original = db[method]
		owned.set(method, { had: Object.hasOwn(db, method), value: target[method] })
		target[method] = function wrapped(this: ProfilableDb, query: string, ...bindings: unknown[]): unknown {
			const outermost = depth === 0
			depth++
			try {
				const out = original.call(this, query, ...bindings)
				if (outermost) record(query, Array.isArray(out) ? out.length : out === undefined ? 0 : 1)
				return out
			} finally {
				depth--
			}
		}
	}

	await scheduler.wait(0)
	const start = Date.now()
	try {
		const result = await work()
		await scheduler.wait(0)
		const wallMs = Date.now() - start

		const shapes = [...counts.values()].sort((left, right) => right.calls - left.calls)
		for (const shape of shapes) {
			const sampled = [...(callers.get(shape.query) ?? new Map<string, number>())]
			const total = sampled.reduce((sum, [, hits]) => sum + hits, 0)
			if (total === 0) continue
			shape.callers = sampled
				.sort((left, right) => right[1] - left[1])
				.slice(0, MAX_CALLERS)
				.map(([frames, hits]) => ({ frames: frames.split('\n'), calls: Math.round((hits / total) * shape.calls) }))
		}
		return {
			result,
			profile: {
				totalCalls: shapes.reduce((total, shape) => total + shape.calls, 0),
				totalRows: shapes.reduce((total, shape) => total + shape.rows, 0),
				wallMs,
				shapes: shapes.slice(0, MAX_SHAPES),
			},
		}
	} finally {
		for (const method of METHODS) {
			const before = owned.get(method)
			if (before?.had === true) target[method] = before.value
			else delete target[method]
		}
	}
}
