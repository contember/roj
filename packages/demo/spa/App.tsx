import { useCallback, useEffect, useRef, useState } from 'react'
import { createRojClient } from '@roj-ai/client/platform'
import { MessageInput, MessageList, QuestionnairePanel, useChat, useSessionStore } from '@roj-ai/client-react'

const PLATFORM_URL = window.location.origin.replace(/:\d+$/, ':2486')
const PRESET_ID = 'app-builder'

interface Session {
	instanceId: string
	sessionId: string
	token: string
	initialPrompt?: string
}

export function App() {
	const [session, setSession] = useState<Session | null>(null)
	const [error, setError] = useState<string | null>(null)

	if (!session) {
		return <Landing onStarted={setSession} onError={setError} error={error} />
	}
	return <Workspace session={session} onExit={() => setSession(null)} />
}

function Landing({
	onStarted,
	onError,
	error,
}: {
	onStarted: (s: Session) => void
	onError: (msg: string | null) => void
	error: string | null
}) {
	const [prompt, setPrompt] = useState('')
	const [loading, setLoading] = useState(false)

	const submit = useCallback(async (e: React.FormEvent) => {
		e.preventDefault()
		const trimmed = prompt.trim()
		if (!trimmed) return
		setLoading(true)
		onError(null)
		try {
			const client = createRojClient({ url: PLATFORM_URL, apiKey: '' })
			const instance = await client.instances.create({
				templateSlug: 'standalone',
				bundleSlug: 'standalone',
				name: `demo-${Date.now()}`,
				vcsType: 'none',
			})
			const session = await client.sessions.create({
				instanceId: instance.instanceId,
				presetId: PRESET_ID,
			})
			onStarted({
				instanceId: instance.instanceId,
				sessionId: session.sessionId,
				token: '',
				initialPrompt: trimmed,
			})
		} catch (err) {
			onError(err instanceof Error ? err.message : 'Failed to start')
			setLoading(false)
		}
	}, [prompt, onStarted, onError])

	return (
		<div className="flex items-center justify-center min-h-screen">
			<form onSubmit={submit} className="w-full max-w-xl px-6">
				<div className="text-4xl mb-4 text-center">🛠</div>
				<h1 className="text-3xl font-semibold text-center mb-2 tracking-tight">App Builder</h1>
				<p className="text-muted-foreground text-center mb-8">Describe a web app. Haiku will build it.</p>

				<div className="surface-elevated rounded-2xl p-1.5">
					<textarea
						value={prompt}
						onChange={e => setPrompt(e.target.value)}
						placeholder="Build me a todo app with dark mode..."
						rows={4}
						className="w-full rounded-xl bg-transparent px-4 py-3.5 text-sm resize-none focus:outline-none placeholder:text-muted-foreground/50"
						disabled={loading}
						autoFocus
					/>
				</div>

				{error && <p className="text-sm text-destructive mt-3">{error}</p>}
				<button
					type="submit"
					disabled={!prompt.trim() || loading}
					className="mt-4 w-full rounded-xl bg-foreground text-background px-4 py-3 text-sm font-medium hover:bg-foreground/90 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
				>
					{loading ? 'Starting…' : 'Start'}
				</button>
			</form>
		</div>
	)
}

function Workspace({ session, onExit }: { session: Session; onExit: () => void }) {
	const chat = useChat({
		platformUrl: PLATFORM_URL,
		instanceId: session.instanceId,
		sessionId: session.sessionId,
		token: session.token,
	})
	// Path-based preview URL for standalone — `usePreviewUrl` requires a
	// `service.code` that the worker assigns but the SDK doesn't populate,
	// so build it here from the serviceType directly. Standalone's
	// preview-proxy resolves /api/v1/instances/{id}/preview/{type}/* to the
	// dev service port for that session.
	const devService = useSessionStore((s) => s.services.get('dev'))
	const previewUrl =
		devService?.status === 'ready'
			? `${PLATFORM_URL}/api/v1/instances/${session.instanceId}/preview/dev/`
			: null
	// Re-mount the iframe when the service port changes OR after each agent
	// response. The dev service (`bunx serve`) is auto-started before the
	// agent writes any files, so the first load shows an empty directory
	// listing. Remounting after messages arrive picks up the new files.
	const messageCount = chat.messages.length
	const iframeKey = `${devService?.port ?? 'pending'}-${messageCount}`

	const initialSent = useRef(false)
	useEffect(() => {
		if (
			!initialSent.current
			&& session.initialPrompt
			&& chat.initStatus === 'ready'
			&& chat.isConnected
			&& chat.isAgentConnected
		) {
			initialSent.current = true
			void chat.sendMessage(session.initialPrompt)
		}
	}, [chat, session.initialPrompt])

	return (
		<div className="flex h-screen">
			<div className="w-[420px] min-w-[320px] surface-elevated flex flex-col m-3 mr-3 rounded-xl overflow-hidden">
				<div className="flex items-center justify-between px-4 py-3 border-b">
					<div className="flex items-center gap-2.5">
						<div className={`h-2 w-2 rounded-full ${chat.isConnected ? 'bg-emerald-500' : 'bg-amber-500 animate-pulse'}`} />
						<span className="text-xs text-muted-foreground font-medium">
							{chat.isConnected ? 'Connected' : chat.initStatus}
						</span>
					</div>
					<button onClick={onExit} className="text-xs text-muted-foreground hover:text-foreground">New session</button>
				</div>

				{chat.initStatus !== 'ready' ? (
					<div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
						Connecting…
					</div>
				) : (
					<>
						<div className="flex-1 overflow-y-auto px-5 py-5 scrollbar-thin">
							<MessageList messages={chat.messages} isAgentTyping={chat.isAgentTyping} />
						</div>
						<div className="p-3 border-t">
							{chat.pendingQuestions.length > 0
								? <QuestionnairePanel questions={chat.pendingQuestions} />
								: <MessageInput disabled={chat.isAgentTyping} />}
						</div>
					</>
				)}
			</div>

			{previewUrl ? (
				<iframe
					key={iframeKey}
					src={previewUrl}
					className="flex-1 m-3 ml-0 rounded-xl border-0 bg-white shadow-sm"
					title="Preview"
					sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
				/>
			) : (
				<div className="flex-1 m-3 ml-0 rounded-xl bg-surface flex items-center justify-center text-sm text-muted-foreground">
					Building preview…
				</div>
			)}
		</div>
	)
}
