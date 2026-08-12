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

export interface SqlShape {
	/** Statement text, whitespace collapsed and truncated. */
	query: string
	calls: number
	/** Rows handed back, summed — only `all` returns more than one. */
	rows: number
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

function normalize(query: string): string {
	const collapsed = query.replace(/\s+/g, ' ').trim()
	return collapsed.length > MAX_QUERY_CHARS ? `${collapsed.slice(0, MAX_QUERY_CHARS)}…` : collapsed
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

	const record = (query: string, rows: number): void => {
		const key = normalize(query)
		const shape = counts.get(key)
		if (shape === undefined) counts.set(key, { query: key, calls: 1, rows })
		else {
			shape.calls++
			shape.rows += rows
		}
	}

	for (const method of METHODS) {
		const original = db[method]
		owned.set(method, { had: Object.hasOwn(db, method), value: target[method] })
		target[method] = function wrapped(this: ProfilableDb, query: string, ...bindings: unknown[]): unknown {
			const out = original.call(this, query, ...bindings)
			record(query, Array.isArray(out) ? out.length : out === undefined ? 0 : 1)
			return out
		}
	}

	await scheduler.wait(0)
	const start = Date.now()
	try {
		const result = await work()
		await scheduler.wait(0)
		const wallMs = Date.now() - start

		const shapes = [...counts.values()].sort((left, right) => right.calls - left.calls)
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
