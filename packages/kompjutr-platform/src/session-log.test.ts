import { Database } from '@kompjutr/do'
import { expect, test } from 'bun:test'
import { KompjutrSessionLog } from './session-log.js'
import { BunSqliteStorage } from './testing/storage.js'

test('an initial sequence SELECT failure is swallowed and the next append recovers', async () => {
	const storage = new BunSqliteStorage()
	const db = new Database(storage)
	const log = new KompjutrSessionLog(db)
	db.run('ALTER TABLE roj_session_log RENAME TO unavailable_log')

	expect(() => log.append('session-a', 'dropped')).not.toThrow()
	db.run('ALTER TABLE unavailable_log RENAME TO roj_session_log')
	log.append('session-a', 'recovered')

	expect(await log.read('session-a', 0)).toEqual({ lines: ['recovered'], offset: 1 })
	storage.close()
})

test('an INSERT failure invalidates the sequence cache before the next append', async () => {
	const storage = new BunSqliteStorage()
	const db = new Database(storage)
	const log = new KompjutrSessionLog(db)
	log.append('session-a', 'first')
	db.run('INSERT INTO roj_session_log (session_id, seq, line) VALUES (?, ?, ?)', 'session-a', 2, 'external')

	expect(() => log.append('session-a', 'collision')).not.toThrow()
	log.append('session-a', 'recovered')

	expect(await log.read('session-a', 0)).toEqual({ lines: ['first', 'external', 'recovered'], offset: 3 })
	storage.close()
})
