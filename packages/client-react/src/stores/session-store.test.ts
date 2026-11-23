import { afterEach, describe, expect, it } from 'bun:test'
import { SessionId } from '@roj-ai/shared'
import { type PendingAttachment, type PendingQuestion, useSessionStore } from './session-store.js'

const IN_FLIGHT: PendingAttachment['status'][] = ['uploading', 'processing']

const question: PendingQuestion = {
	questionId: 'q1',
	question: 'Which logo should I use?',
	inputType: { type: 'text', allowAttachments: true },
	timestamp: 1,
}

function sessionWithAttachment(status: PendingAttachment['status'], pendingQuestions: PendingQuestion[] = []): void {
	useSessionStore.setState({
		sessionId: SessionId('session-1'),
		entryAgentId: 'agent-1',
		messages: [],
		pendingQuestions,
		draftAnswers: new Map([[question.questionId, 'This one']]),
		questionSubmitStatus: new Map(),
		pendingAttachments: new Map([['upload-1', { uploadId: 'upload-1', filename: 'logo.png', status }]]),
	})
}

afterEach(() => {
	useSessionStore.setState({
		sessionId: null,
		entryAgentId: null,
		messages: [],
		pendingQuestions: [],
		draftAnswers: new Map(),
		questionSubmitStatus: new Map(),
		pendingAttachments: new Map(),
	})
})

// The server delivers an upload with the message sent after it is ready; one sent before goes without it.
describe('sending while an attachment is on its way', () => {
	it.each(IN_FLIGHT)('does not send a message while an attachment is %s', async (status) => {
		sessionWithAttachment(status)
		// Read before awaiting: a send that went out shows its optimistic message at once, and a failed request removes it again.
		const sending = useSessionStore.getState().sendMessage('Put it in the footer')
		expect(useSessionStore.getState().messages).toEqual([])
		await sending
		expect(useSessionStore.getState().pendingAttachments.get('upload-1')?.status).toBe(status)
	})

	it('does not submit ask_user answers while an attachment is processing', async () => {
		sessionWithAttachment('processing', [question])
		await useSessionStore.getState().submitAllAnswers()
		expect(useSessionStore.getState().questionSubmitStatus.get(question.questionId)).toBeUndefined()
		expect(useSessionStore.getState().pendingQuestions).toEqual([question])
		expect(useSessionStore.getState().pendingAttachments.size).toBe(1)
	})

	it('does not answer a single question while an attachment is processing', async () => {
		sessionWithAttachment('processing', [question])
		await useSessionStore.getState().answerQuestion(question.questionId, 'This one')
		expect(useSessionStore.getState().questionSubmitStatus.get(question.questionId)).toBeUndefined()
		expect(useSessionStore.getState().pendingQuestions).toEqual([question])
	})
})
