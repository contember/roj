import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentId } from '~/core/agents/schema.js'
import { createNodeFileSystem } from '~/testing/node-platform.js'
import { FileHistoryOffloader } from './history-offloader.js'

// ============================================================================
// Test Constants
// ============================================================================

const TEST_SESSION_DIR = '/tmp/roj-test-history-offloader'

// ============================================================================
// Test Setup
// ============================================================================

beforeAll(async () => {
	await mkdir(TEST_SESSION_DIR, { recursive: true })
})

afterAll(async () => {
	if (existsSync(TEST_SESSION_DIR)) {
		await rm(TEST_SESSION_DIR, { recursive: true })
	}
})

// ============================================================================
// Tests
// ============================================================================

describe('FileHistoryOffloader', () => {
	it('creates history file with content', async () => {
		const offloader = new FileHistoryOffloader(TEST_SESSION_DIR, createNodeFileSystem())
		const agentId = AgentId('test-agent-1')
		const content = 'User: Hello\n\nAgent: Hi there!'

		const path = await offloader.offload(agentId, content, '/session/.history/')

		// Verify returned path
		expect(path).toBe('/session/.history/test-agent-1/history.md')

		// Verify file was created
		const absolutePath = join(TEST_SESSION_DIR, '.history', agentId, 'history.md')
		expect(existsSync(absolutePath)).toBe(true)

		// Verify content
		const fileContent = await readFile(absolutePath, 'utf-8')
		expect(fileContent).toContain('## Summarized at')
		expect(fileContent).toContain('User: Hello')
		expect(fileContent).toContain('Agent: Hi there!')
		expect(fileContent).toContain('---')
	})

	it('appends to existing history file', async () => {
		const offloader = new FileHistoryOffloader(TEST_SESSION_DIR, createNodeFileSystem())
		const agentId = AgentId('test-agent-2')

		// First offload
		await offloader.offload(agentId, 'First conversation', '/session/.history/')

		// Second offload
		await offloader.offload(agentId, 'Second conversation', '/session/.history/')

		// Verify both are in the file
		const absolutePath = join(TEST_SESSION_DIR, '.history', agentId, 'history.md')
		const fileContent = await readFile(absolutePath, 'utf-8')

		// Should contain both conversations
		expect(fileContent).toContain('First conversation')
		expect(fileContent).toContain('Second conversation')

		// Should have two "Summarized at" headers
		const summaryHeaders = fileContent.match(/## Summarized at/g)
		expect(summaryHeaders?.length).toBe(2)
	})

	it('creates parent directories if they do not exist', async () => {
		const offloader = new FileHistoryOffloader(TEST_SESSION_DIR, createNodeFileSystem())
		const agentId = AgentId('test-agent-3')

		// Use a deep path prefix
		const path = await offloader.offload(agentId, 'Content', '/session/.deep/nested/history/')

		expect(path).toBe('/session/.deep/nested/history/test-agent-3/history.md')

		const absolutePath = join(TEST_SESSION_DIR, '.deep/nested/history', agentId, 'history.md')
		expect(existsSync(absolutePath)).toBe(true)
	})

	it('handles path prefix without trailing slash', async () => {
		const offloader = new FileHistoryOffloader(TEST_SESSION_DIR, createNodeFileSystem())
		const agentId = AgentId('test-agent-4')

		const path = await offloader.offload(agentId, 'Content', '/session/.history')

		expect(path).toBe('/session/.history/test-agent-4/history.md')
	})
})
