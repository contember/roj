import { describe, expect, test } from 'bun:test'
import { createVfsRevision } from './fs-revision.js'
import type { VfsRevisionSource } from './fs-revision.js'

/** Stands in for `Workspace['db']`: one query, one answer. */
function source(answer: () => unknown): VfsRevisionSource {
	return { one: answer }
}

describe('createVfsRevision', () => {
	test('reports the counter dofs keeps in vfs_meta', async () => {
		expect(await createVfsRevision(source(() => ({ v: 42 }))).current()).toBe(42)
	})

	test('reports nothing when the row is absent', async () => {
		expect(await createVfsRevision(source(() => undefined)).current()).toBeUndefined()
	})

	test('reports nothing when the column is not a number', async () => {
		expect(await createVfsRevision(source(() => ({ v: 'x' }))).current()).toBeUndefined()
	})

	test('reports nothing when the table is gone, rather than throwing', async () => {
		const missing = source(() => {
			throw new Error('no such table: vfs_meta')
		})
		expect(await createVfsRevision(missing).current()).toBeUndefined()
	})
})
