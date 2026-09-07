import { describe, expect, it } from 'bun:test'
import z from 'zod/v4'
import { MockLLMProvider } from '../llm/mock.js'
import { definePlugin } from '../plugins/plugin-builder.js'
import { createTool } from '../tools/definition.js'
import { ToolCallId } from '../tools/schema.js'
import { createTestPreset, TestHarness } from '~/testing/index.js'
import { mailboxPlugin } from '~/plugins/mailbox/plugin.js'
import { mailboxEvents } from '~/plugins/mailbox/state.js'
import { generateTestMessageId } from '~/plugins/mailbox/schema.js'
import { withSessionId } from '../events/test-helpers.js'
import { Ok } from '~/lib/utils/result.js'
import { MemoryEventStore } from '../events/memory.js'
import type { DomainEvent } from '../events/types.js'
import type { SessionId } from '../sessions/schema.js'
import type { InferenceContext, InferenceRequest } from '../llm/provider.js'

describe('agent park boundaries', () => {
	for (const boundary of ['inference', 'tool', 'completion append']) {
		it(`finishes the admitted ${boundary} and preserves remaining tool IDs for replacement`, async () => {
			const entered = Promise.withResolvers<void>()
			const release = Promise.withResolvers<void>()
			const executed: string[] = []
			let inferenceSignal: AbortSignal | undefined
			class SignalledProvider extends MockLLMProvider {
				override inference(request: InferenceRequest, context?: InferenceContext) {
					inferenceSignal = context?.signal
					return super.inference(request)
				}
			}
			class CompletionStore extends MemoryEventStore {
				override async append(id: SessionId, event: DomainEvent): Promise<void> {
					if (boundary === 'completion append' && event.type === 'inference_completed') {
						entered.resolve()
						await release.promise
					}
					await super.append(id, event)
				}
			}
			const tools = definePlugin('handoff-tools').tools(() => [createTool({
				name: 'record', input: z.object({ value: z.string() }), description: 'Record a value',
				execute: async (input) => {
					executed.push(input.value)
					if (boundary === 'tool' && input.value === 'first') {
						entered.resolve()
						await release.promise
					}
					return Ok(input.value)
				},
			})]).build()
			let calls = 0
			const provider = new SignalledProvider(async () => {
				calls++
				if (calls === 1 && boundary === 'inference') {
					entered.resolve()
					await release.promise
				}
				return {
					content: calls === 1 ? null : 'done',
					toolCalls: calls === 1 ? [
						{ id: ToolCallId('first-id'), name: 'record', input: { value: 'first' } },
						{ id: ToolCallId('second-id'), name: 'record', input: { value: 'second' } },
					] : [],
					finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics(),
				}
			})
			const host = new TestHarness({ presets: [createTestPreset()], llmProvider: provider, eventStore: new CompletionStore(), systemPlugins: [mailboxPlugin, tools] })
			const created = await host.createSession('test')
			const loaded = await host.sessionManager.getSession(created.sessionId)
			const activation = host.sessionManager.activateSession(created.sessionId)
			if (!loaded.ok || !activation.ok) throw new Error('Session unavailable')
			const session = loaded.value
			const agent = session.getEntryAgent()
			if (!agent) throw new Error('Agent missing')
			await session.store.emit(withSessionId(session.id, mailboxEvents.create('mailbox_message', {
				toAgentId: agent.id, sequence: 1,
				message: { id: generateTestMessageId(), from: 'user', content: 'run', timestamp: 1, consumed: false },
			})))
			const processing = agent.continue()
			await entered.promise
			let parked = false
			const parking = host.sessionManager.parkSession(activation.value).then(() => { parked = true })
			expect(parked).toBe(false)
			expect(inferenceSignal?.aborted).toBe(false)
			release.resolve()
			await Promise.all([processing, parking])
			expect(inferenceSignal?.aborted).toBe(false)
			expect(executed).toEqual(boundary === 'tool' ? ['first'] : [])
			const pending = session.store.getAgentState(agent.id)?.pendingToolCalls.map((call) => call.id)
			expect(pending).toEqual(boundary === 'tool' ? ['second-id'] : ['first-id', 'second-id'])
			expect(host.sessionManager.activateSession(session.id).ok).toBe(true)
			const replacement = await host.sessionManager.getSession(session.id)
			if (!replacement.ok) throw new Error(replacement.error.message)
			await replacement.value.getEntryAgent()?.waitForIdle()
			expect(executed).toEqual(['first', 'second'])
			await host.shutdown()
		})
	}
})
