/**
 * Payload size cliffs — how big a single value can get before the platform
 * refuses to carry it, and what roj does when it hits that point.
 *
 * Four dimensions, each selectable through `?dims=` so one that fills storage
 * or takes the isolate down cannot stop the others running:
 *
 * - `sqlite`  — one TEXT column value, raw and through `SqliteEventStore`.
 * - `ws`      — one broadcast frame, through the chain `do-transport` uses.
 * - `fs`      — one workspace file, written and read back through `platform.fs`.
 * - `cascade` — the realistic chain: `read_file` on a large file, whose result
 *   becomes an event that is persisted *and* broadcast.
 *
 * Every dimension binary-searches its own ceiling: `<dim>Min` / `<dim>Max` bound
 * the search, `<dim>Tol` is how tight it converges, `<dim>At` runs one size and
 * skips the search — the knob for re-probing a size that killed the isolate.
 * `ws` takes `?wsOrigin=http://localhost:PORT` as well, which adds a second
 * search over a real network hop (`wsNetMin`/`wsNetMax`/`wsNetTol`/`wsNetAt`);
 * `cascade` takes `cascadeMaxRead` and `cascadeMaxTokens`, the two filesystem
 * plugin limits that decide whether roj truncates before the platform can care.
 *
 * Each attempt is journalled to SQLite before it runs, so an attempt that never
 * returns is still visible on the next request (`?journal=1`). Best effort: a
 * fatal error can take the uncommitted row with it.
 */

import {
	AgentId,
	agentEvents,
	createOrchestrator,
	createPreset,
	createSystemFromServices,
	MockLLMProvider,
	ModelId,
	ServerAdapter,
	SessionId,
} from '@roj-ai/sdk'
import type { DomainEvent, LLMMessage, Logger, MockInferenceHandler, NotificationDelivery, PluginNotification, Preset, Services, Session } from '@roj-ai/sdk'
import type { Platform } from '@roj-ai/sdk/platform'
import { ToolCallId } from '@roj-ai/sdk/tools'
import { filesystemPlugin } from '@roj-ai/sdk/tools/filesystem'
import type { HibernatableWebSocket } from '@roj-ai/transport/workers'
import { createWorkersWebSocketHandlers } from '@roj-ai/transport/workers'
import { withOwnScheduler } from '../own-scheduler.js'
import type { LimitProbe, LimitProbeContext } from './context.js'

const DIMENSIONS = ['sqlite', 'ws', 'fs', 'cascade'] as const
type Dimension = (typeof DIMENSIONS)[number]

/** Where the fs dimension writes; the cascade writes into its session workspace. */
const FS_DIR = '/payload'

/** File the cascade agent is told to read, as the sandboxed agent sees it. */
const CASCADE_FILE = 'payload-probe.txt'
const CASCADE_VIRTUAL_PATH = `/home/user/workspace/${CASCADE_FILE}`

/** 64 printable ASCII chars, no quotes or newlines — JSON-encodes to its own length. */
const FILLER_UNIT = 'the quick brown fox jumps over the lazy dog while it keeps run'.padEnd(64, '.')

/** The SDK does not export the EventStore interface; take it off Services. */
type EventStoreLike = Services<'isolate'>['eventStore']

interface Attempt {
	bytes: number
	ok: boolean
	ms: number
	/** Whatever the dimension measured on the way — actual wire/row bytes, timings. */
	detail?: Record<string, unknown>
	error?: string
}

interface Search {
	largestOk: number | null
	smallestFail: number | null
	/** How wide the bracket still is — the ceiling sits inside it. */
	resolutionBytes: number | null
	note: string
	attempts: Attempt[]
}

// ============================================================================
// Small shared helpers
// ============================================================================

/** Filler with no JSON-escapable characters, so `n` chars stay `n` bytes on the wire. */
function filler(bytes: number): string {
	if (bytes <= 0) return ''
	return FILLER_UNIT.repeat(Math.ceil(bytes / FILLER_UNIT.length)).slice(0, bytes)
}

/** File-shaped filler: same bulk, but broken into lines so `read_file` sees a real text file. */
function lines(bytes: number): string {
	if (bytes <= 0) return ''
	const line = `${FILLER_UNIT.slice(0, FILLER_UNIT.length - 1)}\n`
	return line.repeat(Math.ceil(bytes / line.length)).slice(0, bytes)
}

function describe(error: unknown): string {
	if (!(error instanceof Error)) return String(error)
	const cause = 'cause' in error && error.cause !== undefined
		? ` (cause: ${error.cause instanceof Error ? `${error.cause.name}: ${error.cause.message}` : String(error.cause)})`
		: ''
	return `${error.name}: ${error.message}${cause}`
}

/** workerd freezes the clock between I/O, so a timer yield is needed before reading it. */
async function now(): Promise<number> {
	await scheduler.wait(0)
	return Date.now()
}

/** Human sizes: `4mb`, `512kb`, `1048576`. */
function parseBytes(raw: string | null, fallback: number): number {
	if (raw === null) return fallback
	const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(raw.trim())
	if (!match) throw new Error(`unparseable size '${raw}'`)
	const scale: Record<string, number> = { b: 1, kb: 1024, mb: 1024 * 1024, gb: 1024 * 1024 * 1024 }
	return Math.round(Number(match[1]) * (scale[(match[2] ?? 'b').toLowerCase()] ?? 1))
}

interface Bounds {
	min: number
	max: number
	tol: number
	at: number | null
}

function bounds(params: URLSearchParams, dim: string, defaults: { min: number; max: number; tol: number }): Bounds {
	return {
		min: parseBytes(params.get(`${dim}Min`), defaults.min),
		max: parseBytes(params.get(`${dim}Max`), defaults.max),
		tol: parseBytes(params.get(`${dim}Tol`), defaults.tol),
		at: params.has(`${dim}At`) ? parseBytes(params.get(`${dim}At`), 0) : null,
	}
}

/**
 * Bisect for the largest size that still works.
 *
 * Probes the ceiling candidate first: most runs are "does it survive `max`",
 * and answering that costs one attempt instead of a full descent.
 */
async function findCeiling(limits: Bounds, run: (bytes: number) => Promise<Attempt>): Promise<Search> {
	const attempts: Attempt[] = []
	const probe = async (bytes: number): Promise<boolean> => {
		const attempt = await run(bytes)
		attempts.push(attempt)
		return attempt.ok
	}

	if (limits.at !== null) {
		const ok = await probe(limits.at)
		return {
			largestOk: ok ? limits.at : null,
			smallestFail: ok ? null : limits.at,
			resolutionBytes: null,
			note: `single shot at ${limits.at} bytes`,
			attempts,
		}
	}

	if (await probe(limits.max)) {
		return { largestOk: limits.max, smallestFail: null, resolutionBytes: null, note: `no ceiling at or below max (${limits.max} bytes)`, attempts }
	}
	if (!(await probe(limits.min))) {
		return { largestOk: null, smallestFail: limits.min, resolutionBytes: null, note: `already fails at min (${limits.min} bytes)`, attempts }
	}

	let ok = limits.min
	let fail = limits.max
	while (fail - ok > limits.tol) {
		const mid = Math.floor((ok + fail) / 2)
		if (await probe(mid)) ok = mid
		else fail = mid
	}
	return { largestOk: ok, smallestFail: fail, resolutionBytes: fail - ok, note: 'bisected', attempts }
}

// ============================================================================
// Journal — survives an attempt that never returns
// ============================================================================

interface Journal {
	run<T extends Attempt>(dim: string, bytes: number, attempt: () => Promise<T>): Promise<T>
	tail(limit: number): unknown[]
}

function openJournal(ctx: DurableObjectState): Journal {
	ctx.storage.sql.exec(
		`CREATE TABLE IF NOT EXISTS payload_probe_journal (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			at INTEGER NOT NULL,
			dim TEXT NOT NULL,
			bytes INTEGER NOT NULL,
			outcome TEXT NOT NULL
		)`,
	)

	return {
		async run(dim, bytes, attempt) {
			ctx.storage.sql.exec('INSERT INTO payload_probe_journal (at, dim, bytes, outcome) VALUES (?, ?, ?, ?)', Date.now(), dim, bytes, 'started')
			const id = ctx.storage.sql.exec<{ id: number }>('SELECT last_insert_rowid() AS id').toArray()[0]?.id ?? 0
			const result = await attempt()
			ctx.storage.sql.exec('UPDATE payload_probe_journal SET outcome = ? WHERE id = ?', result.ok ? 'ok' : `fail: ${result.error ?? ''}`.slice(0, 300), id)
			return result
		},

		tail(limit) {
			return ctx.storage.sql
				.exec<{ id: number; at: number; dim: string; bytes: number; outcome: string }>(
					'SELECT id, at, dim, bytes, outcome FROM payload_probe_journal ORDER BY id DESC LIMIT ?',
					limit,
				)
				.toArray()
		},
	}
}

// ============================================================================
// WebSocket harness — the same chain do-transport broadcasts through
// ============================================================================

interface SocketHarness {
	/** `ServerAdapter.broadcast`, exactly as `createSystemFromServices` calls it — and what it answered. */
	broadcast(notification: PluginNotification): NotificationDelivery
	/** Wire bytes of every frame the client half actually received. */
	readonly received: number[]
	readonly closes: { code: number; reason: string }[]
	/** Frames stuck in `ServerConnection`'s send buffer — i.e. sends that threw. */
	buffered(): number
	clientOpen(): boolean
	/** Drop the peer without touching the server half — what a client disconnect looks like. */
	closePeer(): void
	close(): void
}

function frameBytes(data: unknown): number {
	if (typeof data === 'string') return data.length
	if (data instanceof ArrayBuffer) return data.byteLength
	return -1
}

/**
 * Wire a loopback socket into a real `ServerAdapter`.
 *
 * `mode` picks how the server half is accepted: `hibernatable` is what
 * `do-transport` does, `standard` is the plain `accept()` a non-DO host would
 * use — worth separating, since only the first goes through the runtime's
 * hibernation machinery.
 *
 * The adapter gets the SDK's own logger, as `do-transport` gives it one: a frame
 * over the large-frame threshold and a frame the send buffer discarded are both
 * warnings, and an adapter built without a logger reports neither.
 */
function openSocket(ctx: DurableObjectState, sessionId: string, mode: 'hibernatable' | 'standard', logger: Logger): SocketHarness {
	const adapter = new ServerAdapter({ logger })
	const pair = new WebSocketPair()
	const client = pair[0]
	const server = pair[1]

	const handlers = createWorkersWebSocketHandlers<{ sessionId: string }>({
		onOpen: (ws) => adapter.handleOpen(ws, ws.data.sessionId),
		onClose: (ws, code, reason) => adapter.handleClose(ws, code, reason),
		onMessage: (ws, message) => adapter.handleMessage(ws, message),
		onError: (ws, error) => adapter.handleError(ws, error),
		// The probe owns both halves, so there is no attachment to read back.
		getData: () => ({ sessionId }),
	})

	if (mode === 'hibernatable') ctx.acceptWebSocket(server)
	else server.accept()

	const socket: HibernatableWebSocket = server
	handlers.open(socket)

	const received: number[] = []
	const closes: { code: number; reason: string }[] = []
	client.accept()
	client.addEventListener('message', (event) => {
		received.push(frameBytes(event.data))
	})
	client.addEventListener('close', (event) => {
		closes.push({ code: event.code, reason: event.reason })
	})

	return {
		broadcast: (notification) => adapter.broadcast(notification),
		received,
		closes,
		buffered: () =>
			adapter
				.getConnectionManager()
				.getSubscribers(sessionId)
				.reduce((total, connection) => total + connection.bufferedMessageCount, 0),
		clientOpen: () => client.readyState === WebSocket.READY_STATE_OPEN,
		closePeer: () => client.close(1000, 'peer gone'),
		close: () => {
			try {
				client.close(1000, 'probe done')
			} catch {
				// Already gone — nothing to release.
			}
			try {
				server.close(1000, 'probe done')
			} catch {
				// Already gone — nothing to release.
			}
		},
	}
}

/**
 * What roj does with notifications for a session whose socket has gone.
 *
 * Frames queue in `ServerConnection`'s send buffer and are discarded once it is
 * full. `broadcast` says so per call — `delivered + buffered + dropped === peers`
 * — so the loss is summed off the transport rather than derived from the frames
 * that failed to arrive.
 */
async function measureDropAfterClose(harness: SocketHarness, sessionId: string): Promise<unknown> {
	harness.closePeer()
	await scheduler.wait(50)
	const before = harness.buffered()
	const delivered = harness.received.length
	const attempts = 600
	const reported = { bytes: 0, peers: 0, delivered: 0, buffered: 0, dropped: 0 }
	for (let i = 0; i < attempts; i++) {
		const delivery = harness.broadcast({ pluginName: 'payload-probe', type: 'payload_probe', payload: { sessionId, content: `drop-${i}` } })
		reported.bytes += delivery.bytes
		reported.peers += delivery.peers
		reported.delivered += delivery.delivered
		reported.buffered += delivery.buffered
		reported.dropped += delivery.dropped
	}
	await scheduler.wait(50)
	return {
		clientOpen: harness.clientOpen(),
		broadcastsAfterClose: attempts,
		bufferedBefore: before,
		bufferedAfter: harness.buffered(),
		newFramesDelivered: harness.received.length - delivered,
		/** Summed from what each broadcast returned — the drops are counted, not inferred. */
		reported,
	}
}

/** Frames cross the pair on a later turn, so give the client a moment to see one. */
async function awaitFrame(harness: SocketHarness, before: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (harness.received.length > before) return true
		await scheduler.wait(10)
	}
	return harness.received.length > before
}

// ============================================================================
// sqlite — DO SQLite column values, raw and through SqliteEventStore
// ============================================================================

const ROW_TABLE = 'payload_probe_row'

function bigEvent(sessionId: SessionId, bytes: number): DomainEvent {
	const agentId = AgentId('payload-probe-agent')
	const insert: LLMMessage[] = [{ role: 'assistant', content: filler(bytes) }]
	return Object.assign(
		agentEvents.create('agent_conversation_spliced', { agentId, start: 0, deleteCount: 0, insert }),
		{ sessionId },
	)
}

/** A tiny event, tagged by hook name so the two sides of a rejected append stay distinguishable. */
function markerEvent(sessionId: SessionId, marker: 'onStart' | 'onComplete'): DomainEvent {
	return Object.assign(
		agentEvents.create('handler_started', { agentId: AgentId('payload-probe-agent'), handlerName: marker }),
		{ sessionId },
	)
}

async function rowAttempt(ctx: DurableObjectState, bytes: number): Promise<Attempt> {
	const payload = filler(bytes)
	const start = await now()
	try {
		ctx.storage.sql.exec(`INSERT OR REPLACE INTO ${ROW_TABLE} (id, payload) VALUES (?, ?)`, 1, payload)
	} catch (error) {
		return { bytes, ok: false, ms: (await now()) - start, error: describe(error), detail: { stage: 'insert' } }
	}
	try {
		const readBack = ctx.storage.sql.exec<{ len: number }>(`SELECT LENGTH(payload) AS len FROM ${ROW_TABLE} WHERE id = 1`).toArray()[0]?.len ?? -1
		// Materialise the value itself, not just its length — the read path carries it too.
		const value = ctx.storage.sql.exec<{ payload: string }>(`SELECT payload FROM ${ROW_TABLE} WHERE id = 1`).toArray()[0]?.payload ?? ''
		return {
			bytes,
			ok: readBack === bytes && value.length === bytes,
			ms: (await now()) - start,
			detail: { readBackLength: readBack, valueLength: value.length },
		}
	} catch (error) {
		return { bytes, ok: false, ms: (await now()) - start, error: describe(error), detail: { stage: 'select' } }
	} finally {
		ctx.storage.sql.exec(`DELETE FROM ${ROW_TABLE} WHERE id = 1`)
	}
}

async function eventAttempt(store: EventStoreLike, bytes: number): Promise<Attempt> {
	const sessionId = SessionId(`payload-event-${bytes}-${Date.now()}`)
	const event = bigEvent(sessionId, bytes)
	const start = await now()
	try {
		await store.append(sessionId, event)
	} catch (error) {
		return { bytes, ok: false, ms: (await now()) - start, error: describe(error), detail: { stage: 'append' } }
	}
	try {
		const loaded = await store.load(sessionId)
		const first = loaded[0]
		const roundTripped = first !== undefined && JSON.stringify(first).length >= bytes
		return { bytes, ok: loaded.length === 1 && roundTripped, ms: (await now()) - start, detail: { loaded: loaded.length } }
	} catch (error) {
		return { bytes, ok: false, ms: (await now()) - start, error: describe(error), detail: { stage: 'load' } }
	}
}

/** What a session looks like after an event that the store refused. */
async function sqliteAftermath(ctx: DurableObjectState, store: EventStoreLike, bytes: number): Promise<unknown> {
	const sessionId = SessionId(`payload-aftermath-${Date.now()}`)
	await store.append(sessionId, markerEvent(sessionId, 'onStart'))

	let rejection: string | null = null
	try {
		await store.append(sessionId, bigEvent(sessionId, bytes))
	} catch (error) {
		rejection = describe(error)
	}

	let afterAppend: string | null = null
	try {
		await store.append(sessionId, markerEvent(sessionId, 'onComplete'))
	} catch (error) {
		afterAppend = describe(error)
	}

	const events = await store.load(sessionId)
	let sqlStillWorks = true
	try {
		ctx.storage.sql.exec(`INSERT OR REPLACE INTO ${ROW_TABLE} (id, payload) VALUES (?, ?)`, 2, 'still here')
		ctx.storage.sql.exec(`DELETE FROM ${ROW_TABLE} WHERE id = 2`)
	} catch {
		sqlStillWorks = false
	}

	return {
		oversizedEventBytes: bytes,
		rejection,
		rejectedCleanly: rejection !== null,
		appendAfterRejectionError: afterAppend,
		events: events.length,
		eventTypes: events.map((event) => event.type),
		/** A gap here would mean the failed append still consumed a sequence number. */
		gaplessSequence: events.length === 2,
		sqlStillWorks,
	}
}

async function probeSqlite(context: LimitProbeContext, journal: Journal): Promise<unknown> {
	const { ctx, params, boot } = context
	ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS ${ROW_TABLE} (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)`)

	const rowBounds = bounds(params, 'sqlite', { min: 1024, max: 8 * 1024 * 1024, tol: 4096 })
	const row = await findCeiling(rowBounds, (bytes) => journal.run('sqlite:row', bytes, () => rowAttempt(ctx, bytes)))

	const store = boot().services.eventStore
	const event = await findCeiling(rowBounds, (bytes) => journal.run('sqlite:event', bytes, () => eventAttempt(store, bytes)))

	const aftermath = event.smallestFail === null ? null : await sqliteAftermath(ctx, store, event.smallestFail)

	return {
		what: 'largest TEXT column value a DO SQLite row will take, raw and as one roj event',
		rawColumn: row,
		throughEventStore: event,
		aftermath,
		databaseSizeBytes: ctx.storage.sql.databaseSize,
	}
}

// ============================================================================
// ws — one broadcast frame through the do-transport chain
// ============================================================================

async function wsAttempt(harness: SocketHarness, sessionId: string, bytes: number, waitMs: number): Promise<Attempt> {
	const envelope = JSON.stringify({ type: 'payload_probe', payload: { sessionId, content: '' }, ts: Date.now() }).length
	const content = filler(Math.max(bytes - envelope, 0))
	const notification: PluginNotification = { pluginName: 'payload-probe', type: 'payload_probe', payload: { sessionId, content } }

	const before = harness.received.length
	const bufferedBefore = harness.buffered()
	const start = await now()
	const reported = harness.broadcast(notification)
	const delivered = await awaitFrame(harness, before, waitMs)
	const ms = (await now()) - start
	const wire = content.length + envelope
	const arrived = harness.received[harness.received.length - 1] ?? -1

	return {
		bytes: wire,
		ok: delivered && arrived === wire && harness.clientOpen(),
		ms,
		detail: {
			requestedBytes: bytes,
			deliveredBytes: delivered ? arrived : null,
			// What the adapter said became of this frame: a send the socket refused counts
			// as buffered, not delivered, whether it threw or the socket was simply not open.
			reported,
			// A frame the adapter could not hand to the socket lands in the send buffer.
			bufferedDelta: harness.buffered() - bufferedBefore,
			clientOpen: harness.clientOpen(),
			closes: harness.closes.slice(),
		},
		error: delivered ? undefined : 'no frame reached the client half',
	}
}

/**
 * The same question over a real hop, since a loopback `WebSocketPair` never
 * leaves the isolate and so never meets the runtime's frame handling.
 *
 * Only client→server is reachable from here: `/ws` upgrades on the *smoke* DO,
 * so this probe can push frames at workerd but cannot make it push back. That
 * still pins where the runtime refuses a frame, and how the refusal arrives.
 */
async function networkFrameAttempt(origin: string, bytes: number, waitMs: number): Promise<Attempt> {
	const start = await now()
	const response = await fetch(`${origin}/ws?sessionId=payload-net`, { headers: { Upgrade: 'websocket' } })
	const ws = response.webSocket
	if (!ws) return { bytes, ok: false, ms: (await now()) - start, error: `no webSocket on the upgrade response (status ${response.status})` }

	const closes: { code: number; reason: string }[] = []
	ws.accept()
	ws.addEventListener('close', (event) => {
		closes.push({ code: event.code, reason: event.reason })
	})

	let sendError: string | undefined
	try {
		ws.send(filler(bytes))
	} catch (error) {
		sendError = describe(error)
	}
	// A frame the runtime refuses comes back as a close, not as a throw.
	await scheduler.wait(waitMs)
	const closed = closes.length > 0 || ws.readyState !== WebSocket.READY_STATE_OPEN
	try {
		ws.close(1000, 'probe done')
	} catch {
		// Already closed by the runtime.
	}

	return {
		bytes,
		ok: sendError === undefined && !closed,
		ms: (await now()) - start,
		error: sendError ?? (closed ? `socket closed: ${JSON.stringify(closes)}` : undefined),
		detail: { closes, sendThrew: sendError !== undefined },
	}
}

async function probeWs(context: LimitProbeContext, journal: Journal): Promise<unknown> {
	const { ctx, params, boot } = context
	// The adapter's own warnings are half the answer here, so it takes the SDK's logger.
	const logger = boot().services.logger
	const modes: ('hibernatable' | 'standard')[] = (params.get('wsModes') ?? 'hibernatable,standard')
		.split(',')
		.filter((mode): mode is 'hibernatable' | 'standard' => mode === 'hibernatable' || mode === 'standard')
	const waitMs = Number(params.get('wsWaitMs') ?? 2000)
	const limits = bounds(params, 'ws', { min: 1024, max: 16 * 1024 * 1024, tol: 4096 })

	const results: Record<string, unknown> = {}
	for (const mode of modes) {
		const sessionId = `payload-ws-${mode}`
		let harness = openSocket(ctx, sessionId, mode, logger)
		let reopened = 0
		try {
			const search = await findCeiling(limits, (bytes) =>
				journal.run(`ws:${mode}`, bytes, async () => {
					// A frame that killed the socket would fail every later size too, and
					// bisect down to the floor — so start each attempt on a live socket.
					if (!harness.clientOpen()) {
						harness.close()
						harness = openSocket(ctx, sessionId, mode, logger)
						reopened += 1
					}
					return wsAttempt(harness, sessionId, bytes, waitMs)
				}))

			// Per-attempt `reported`, `bufferedDelta` and `closes` already say whether a
			// frame threw or killed the socket. What they cannot show is the other half of
			// the story: what roj does with notifications once the peer is gone.
			const afterPeerClose = await measureDropAfterClose(harness, sessionId)

			results[mode] = { search, socketsKilledDuringSearch: reopened, afterPeerClose }
		} finally {
			harness.close()
		}
	}

	const origin = params.get('wsOrigin')
	const network = origin === null ? null : await findCeiling(
		// Wider than the loopback search on purpose: the runtime's own ceiling is
		// well above what an in-isolate pair ever refuses.
		bounds(params, 'wsNet', { min: 1024, max: 64 * 1024 * 1024, tol: 4096 }),
		(bytes) => journal.run('ws:network', bytes, () => networkFrameAttempt(origin, bytes, Math.min(waitMs, 500))),
	)

	return {
		what: 'largest notification ServerAdapter can hand to a DO WebSocket, and what breaks when it cannot',
		modes: results,
		/** Frames pushed over a real hop into the smoke DO's `/ws` — needs `?wsOrigin=`. */
		networkFrame: network,
	}
}

// ============================================================================
// fs — one workspace file through platform.fs
// ============================================================================

async function fsWriteAttempt(platform: Platform, bytes: number): Promise<Attempt> {
	const path = `${FS_DIR}/write-probe.txt`
	const start = await now()
	try {
		await platform.fs.writeFile(path, lines(bytes))
		const written = await now()
		const stats = await platform.fs.stat(path)
		const text = await platform.fs.readFile(path, 'utf-8')
		const read = await now()
		return {
			bytes,
			ok: stats.size === bytes && text.length === bytes,
			ms: read - start,
			detail: { statSize: stats.size, readLength: text.length, writeMs: written - start, readMs: read - written },
		}
	} catch (error) {
		return { bytes, ok: false, ms: (await now()) - start, error: describe(error) }
	} finally {
		await platform.fs.rm(path, { force: true })
	}
}

/** `appendFile` is implemented as `writeRangeSync` at the current end — probe that path. */
async function fsAppendAttempt(platform: Platform, bytes: number): Promise<Attempt> {
	const path = `${FS_DIR}/append-probe.txt`
	const base = lines(1024)
	const start = await now()
	try {
		await platform.fs.writeFile(path, base)
		await platform.fs.appendFile(path, lines(bytes))
		const stats = await platform.fs.stat(path)
		return { bytes, ok: stats.size === base.length + bytes, ms: (await now()) - start, detail: { statSize: stats.size, expected: base.length + bytes } }
	} catch (error) {
		return { bytes, ok: false, ms: (await now()) - start, error: describe(error) }
	} finally {
		await platform.fs.rm(path, { force: true })
	}
}

/** Whether appending stays chunk-local or pays for the whole file each time. */
async function appendCost(platform: Platform, sizes: number[]): Promise<unknown[]> {
	const path = `${FS_DIR}/append-cost.txt`
	const chunk = lines(64 * 1024)
	const out: unknown[] = []
	for (const size of sizes) {
		try {
			await platform.fs.writeFile(path, lines(size))
			const start = await now()
			await platform.fs.appendFile(path, chunk)
			const ms = (await now()) - start
			const stats = await platform.fs.stat(path)
			out.push({ fileBytes: size, appendBytes: chunk.length, ms, resultingSize: stats.size, ok: stats.size === size + chunk.length })
		} catch (error) {
			out.push({ fileBytes: size, error: describe(error) })
		} finally {
			await platform.fs.rm(path, { force: true })
		}
	}
	return out
}

async function probeFs(context: LimitProbeContext, journal: Journal): Promise<unknown> {
	const { platform, params } = context
	await platform.fs.mkdir(FS_DIR, { recursive: true })

	const limits = bounds(params, 'fs', { min: 4096, max: 64 * 1024 * 1024, tol: 64 * 1024 })
	const write = await findCeiling(limits, (bytes) => journal.run('fs:write', bytes, () => fsWriteAttempt(platform, bytes)))
	const append = await findCeiling(limits, (bytes) => journal.run('fs:append', bytes, () => fsAppendAttempt(platform, bytes)))
	const cost = params.get('fsAppendCost') === '0'
		? null
		: await appendCost(platform, (params.get('fsAppendCostSizes') ?? '1mb,4mb,16mb').split(',').map((size) => parseBytes(size, 0)))

	return {
		what: 'largest file platform.fs can write and read back whole through the workspace provider',
		write,
		append,
		appendCost: cost,
	}
}

// ============================================================================
// cascade — read_file → tool result → event → persisted and broadcast
// ============================================================================

let cascadeCallSeq = 0

const cascadeHandler: MockInferenceHandler = (request) => {
	const offered = new Set((request.tools ?? []).map((tool) => tool.name))
	const alreadyRead = request.messages.some((message: LLMMessage) =>
		message.role === 'assistant' && (message.toolCalls ?? []).some((call) => call.name === 'read_file')
	)
	const metrics = MockLLMProvider.defaultMetrics()

	if (offered.has('read_file') && !alreadyRead) {
		cascadeCallSeq += 1
		return {
			content: `Reading ${CASCADE_VIRTUAL_PATH}.`,
			toolCalls: [{ id: ToolCallId(`payload-read-${cascadeCallSeq}`), name: 'read_file', input: { path: CASCADE_VIRTUAL_PATH } }],
			finishReason: 'tool_calls',
			metrics,
		}
	}
	return { content: 'Done.', toolCalls: [], finishReason: 'stop', metrics }
}

function cascadePreset(maxReadSize: number, maxTokens: number): Preset {
	return createPreset({
		id: 'payload-cascade',
		name: 'Payload cascade',
		workspaceDir: '/workspace/{sessionId}',
		sandboxed: true,
		plugins: [filesystemPlugin.configure({ maxReadSize, maxTokens })],
		orchestrator: createOrchestrator({
			system: 'You read the file you are asked to read.',
			model: ModelId('mock/model'),
			plugins: [filesystemPlugin.configureAgent({})],
			tools: [],
			agents: [],
		}),
	})
}

/** Mirrors the DO's own #waitForIdle — testing/wait-helpers pulls in node:fs. */
async function waitForIdle(session: Session, timeoutMs: number): Promise<boolean> {
	const isIdle = () => {
		for (const [agentId] of session.state.agents) {
			const agent = session.getAgent(agentId)
			const state = agent?.state
			if (!agent || !state) continue
			if (state.status !== 'pending' || state.pendingToolCalls.length > 0 || state.pendingToolResults.length > 0 || agent.isScheduled()) return false
		}
		return true
	}

	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (isIdle()) {
			await scheduler.wait(20)
			if (isIdle()) return true
		}
		await scheduler.wait(20)
	}
	return false
}

/**
 * The whole chain at one file size.
 *
 * Every link is reported separately, because "the chain broke" is only useful
 * when it says which link went first: the write into the workspace, the tool's
 * own read, the event the result becomes, or the frame it is broadcast on.
 */
async function probeCascade(context: LimitProbeContext, journal: Journal): Promise<unknown> {
	const { platform, ctx, params, boot } = context
	const maxReadSize = parseBytes(params.get('cascadeMaxRead'), 10 * 1024 * 1024)
	const maxTokens = Number(params.get('cascadeMaxTokens') ?? 20_000)
	const timeoutMs = Number(params.get('cascadeTimeoutMs') ?? 30_000)
	const waitMs = Number(params.get('wsWaitMs') ?? 2000)
	const limits = bounds(params, 'cascade', { min: 64 * 1024, max: 32 * 1024 * 1024, tol: 256 * 1024 })

	const preset = cascadePreset(maxReadSize, maxTokens)
	const mock = new MockLLMProvider(cascadeHandler)
	// Own manager, so own scheduler: the DO's alarm dispatches into the manager it
	// booted, and this one's agents would wait on wakes nobody delivers.
	const services: Services<'isolate'> = {
		...withOwnScheduler(boot().services),
		presets: new Map([[preset.id, preset]]),
		llmProvider: mock,
		llmProviders: new Map([['mock', mock]]),
	}

	let harness: SocketHarness | null = null
	const notified: { type: string; payloadBytes: number }[] = []
	const system = createSystemFromServices(services, {
		onUserOutput: (notification) => {
			notified.push({ type: notification.type, payloadBytes: JSON.stringify(notification.payload).length })
			harness?.broadcast(notification)
		},
	})

	const attempt = async (bytes: number): Promise<Attempt> => {
		const start = await now()
		const created = await system.sessionManager.createSession(preset.id)
		if (!created.ok) {
			return { bytes, ok: false, ms: (await now()) - start, error: JSON.stringify(created.error), detail: { brokeAt: 'createSession' } }
		}
		const session = created.value
		const sessionId = String(session.id)
		const socket = openSocket(ctx, sessionId, 'hibernatable', services.logger)
		harness = socket
		notified.length = 0

		try {
			try {
				await platform.fs.mkdir(`/workspace/${sessionId}`, { recursive: true })
				await platform.fs.writeFile(`/workspace/${sessionId}/${CASCADE_FILE}`, lines(bytes))
			} catch (error) {
				return { bytes, ok: false, ms: (await now()) - start, error: describe(error), detail: { brokeAt: 'write' } }
			}

			const agentId = session.getEntryAgentId()
			if (!agentId) return { bytes, ok: false, ms: (await now()) - start, error: 'no entry agent', detail: { brokeAt: 'createSession' } }

			const sent = await session.callPluginMethod('user-chat.sendMessage', {
				sessionId,
				content: `Read ${CASCADE_VIRTUAL_PATH}.`,
				agentId: String(agentId),
			})
			if (!sent.ok) return { bytes, ok: false, ms: (await now()) - start, error: JSON.stringify(sent.error), detail: { brokeAt: 'sendMessage' } }

			const settled = await waitForIdle(session, timeoutMs)
			const events = await services.eventStore.load(session.id)
			const toolEvent = events.find((event) => event.type === 'tool_completed' || event.type === 'tool_failed')
			const largest = events.reduce((max, event) => Math.max(max, JSON.stringify(event).length), 0)
			// No dedicated error event type — an errored agent shows up as agent_state_changed.
			const eventTypes = [...new Set(events.map((event) => event.type))]

			// Notifications are handed over synchronously but cross the pair a turn later.
			await scheduler.wait(Math.min(waitMs, 250))
			const undelivered = socket.buffered()

			const readOk = toolEvent?.type === 'tool_completed'
			const persistOk = toolEvent !== undefined
			const broadcastOk = undelivered === 0 && socket.clientOpen()
			const brokeAt = !persistOk ? 'persist' : !readOk ? 'read' : !broadcastOk ? 'broadcast' : !settled ? 'idle' : null

			return {
				bytes,
				ok: brokeAt === null,
				ms: (await now()) - start,
				error: brokeAt === null ? undefined : `broke at ${brokeAt}`,
				detail: {
					brokeAt,
					settled,
					events: events.length,
					largestEventBytes: largest,
					toolEventType: toolEvent?.type ?? null,
					toolEventBytes: toolEvent === undefined ? null : JSON.stringify(toolEvent).length,
					toolEventPreview: toolEvent === undefined ? null : JSON.stringify(toolEvent).slice(0, 300),
					eventTypes,
					notifications: notified.slice(),
					framesDelivered: socket.received.length,
					largestFrameBytes: socket.received.reduce((max, size) => Math.max(max, size), 0),
					undeliveredFrames: undelivered,
					socketOpen: socket.clientOpen(),
				},
			}
		} catch (error) {
			return { bytes, ok: false, ms: (await now()) - start, error: describe(error), detail: { brokeAt: 'threw' } }
		} finally {
			harness = null
			socket.close()
			await session.close()
			// Each attempt leaves a multi-MB file behind; a search would otherwise
			// grow the DO's storage by the sum of every size it tried.
			await platform.fs.rm(`/workspace/${sessionId}/${CASCADE_FILE}`, { force: true })
			await scheduler.wait(0)
		}
	}

	const search = await findCeiling(limits, (bytes) => journal.run('cascade', bytes, () => attempt(bytes)))

	return {
		what: 'largest file an agent can read with read_file and still have the result persisted and broadcast',
		filesystemConfig: { maxReadSize, maxTokens },
		search,
	}
}

// ============================================================================
// Entry point
// ============================================================================

export const payloadProbe: LimitProbe = async (context) => {
	const { params } = context
	const journal = openJournal(context.ctx)

	if (params.get('journal') === '1') {
		return { journal: journal.tail(Number(params.get('journalLimit') ?? 40)) }
	}

	const requested = (params.get('dims') ?? DIMENSIONS.join(',')).split(',').map((dim) => dim.trim())
	const unknown = requested.filter((dim) => !DIMENSIONS.some((known) => known === dim))
	if (unknown.length > 0) throw new Error(`unknown dims: ${unknown.join(',')} (known: ${DIMENSIONS.join(',')})`)

	const results: Record<string, unknown> = {}
	for (const dim of DIMENSIONS) {
		if (!requested.includes(dim)) continue
		if (dim === 'sqlite') results.sqlite = await probeSqlite(context, journal)
		if (dim === 'ws') results.ws = await probeWs(context, journal)
		if (dim === 'fs') results.fs = await probeFs(context, journal)
		if (dim === 'cascade') results.cascade = await probeCascade(context, journal)
	}

	return results
}
