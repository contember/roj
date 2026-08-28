import { expect, test } from 'bun:test'
import { createGit, Workspace } from 'kompjutr'
import { createShell } from 'kompjutr/shell'
import { BunSqliteStorage, MAX_BIND_PARAMETERS } from './storage.js'

function workspace(): Workspace {
	return new Workspace({
		storage: new BunSqliteStorage(),
		git: createGit(),
		defaultGitIdentity: { name: 'Roj', email: 'roj@example.com' },
	})
}

const utf8 = new TextEncoder()
const text = new TextDecoder()

test('a filesystem writes and reads back', () => {
	const ws = workspace()
	ws.filesystem.mkdir('/w', { recursive: true })
	ws.filesystem.writeFile('/w/a.txt', utf8.encode('hello'))

	expect(text.decode(ws.filesystem.readFile('/w/a.txt'))).toBe('hello')
	expect(ws.filesystem.rev()).toBeGreaterThan(0)
})

test('git commits and reports a dirty worktree', async () => {
	const ws = workspace()
	await ws.git.init({ dir: '/' })
	ws.filesystem.writeFile('/note.txt', utf8.encode('first\n'))
	await ws.git.add({ paths: ['note.txt'] })

	const commit = await ws.git.commit({ message: 'first' })
	expect(commit.oid).toMatch(/^[0-9a-f]{40}$/)

	ws.filesystem.writeFile('/scratch.txt', utf8.encode('x\n'))
	expect(JSON.stringify(await ws.git.status({ dir: '/' }))).toContain('scratch.txt')
})

test('the shell runs a pipeline over the same database', () => {
	const ws = workspace()
	ws.filesystem.writeFile('/a.txt', utf8.encode('b\na\nc\n'))

	const run = createShell({ fs: ws.filesystem }).run('cat /a.txt | sort | head -2')

	expect(run.exitCode).toBe(0)
	expect(run.stdout).toBe('a\nb\n')
})

test('a statement runs even when nothing reads its rows', () => {
	const storage = new BunSqliteStorage()
	storage.sql.exec('CREATE TABLE t (a)')

	// Would raise "no such table" if the cursor only ran the statement on iteration.
	expect(storage.sql.exec('SELECT count(*) AS n FROM t').toArray()).toEqual([{ n: 0 }])
})

test('a cursor yields rows without materialising them', () => {
	const storage = new BunSqliteStorage()
	storage.sql.exec('CREATE TABLE t (a)')
	for (const value of [1, 2, 3]) storage.sql.exec('INSERT INTO t VALUES (?)', value)

	storage.resetCounters()
	const cursor = storage.sql.exec<{ a: number }>('SELECT a FROM t ORDER BY a')
	const first = cursor[Symbol.iterator]().next()

	expect(first.value).toEqual({ a: 1 })
	expect(storage.rowCount).toBe(1)
	expect(storage.statementCount).toBe(1)
})

test('binding past what a Durable Object allows raises, as workerd does', () => {
	const storage = new BunSqliteStorage()
	storage.sql.exec('CREATE TABLE t (a)')
	const values = Array.from({ length: MAX_BIND_PARAMETERS + 1 }, (_, index) => index)
	const placeholders = values.map(() => '(?)').join(',')

	expect(() => storage.sql.exec(`INSERT INTO t VALUES ${placeholders}`, ...values)).toThrow(/too many SQL variables/)
})

test('a failed transaction leaves nothing behind', () => {
	const storage = new BunSqliteStorage()
	storage.sql.exec('CREATE TABLE t (a)')

	expect(() =>
		storage.transactionSync(() => {
			storage.sql.exec('INSERT INTO t VALUES (1)')
			throw new Error('abandoned')
		}),
	).toThrow('abandoned')

	expect(storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM t').toArray()).toEqual([{ n: 0 }])
})
