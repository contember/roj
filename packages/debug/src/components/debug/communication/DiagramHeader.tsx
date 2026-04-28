import { DebugLink } from '../DebugNavigation'
import type { DiagramParticipant } from './types'
import { COLORS, LAYOUT } from './types'

interface DiagramHeaderProps {
	participants: DiagramParticipant[]
	zoom: number
}

export function DiagramHeader({ participants, zoom }: DiagramHeaderProps) {
	const scaledTimeAxisWidth = LAYOUT.timeAxisWidth * zoom
	const scaledParticipantWidth = LAYOUT.participantWidth * zoom
	const scaledParticipantGap = LAYOUT.participantGap * zoom

	return (
		<div
			className="sticky top-0 z-10 bg-white border-b border-slate-200 flex shrink-0 overflow-hidden"
			style={{ height: LAYOUT.headerHeight }}
		>
			{/* Time axis header */}
			<div
				className="flex items-center justify-center text-[10px] font-medium text-slate-400 uppercase tracking-wider border-r border-slate-200 shrink-0 bg-slate-50"
				style={{ width: scaledTimeAxisWidth }}
			>
				Time
			</div>

			{/* Participant headers */}
			{participants.map((participant, idx) => {
				const isOdd = idx % 2 === 1
				return (
					<div
						key={participant.id}
						className={`flex flex-col items-center justify-center shrink-0 py-2 border-l border-slate-200 ${isOdd ? 'bg-slate-50/80' : 'bg-white'}`}
						style={{
							width: scaledParticipantWidth + scaledParticipantGap,
							paddingLeft: scaledParticipantGap / 2,
							paddingRight: scaledParticipantGap / 2,
						}}
					>
						{participant.id === 'user'
							? (
								<div className="flex items-center gap-1.5">
									<UserIcon />
									<span className={`text-xs font-semibold ${COLORS.participant.user}`}>
										{participant.name}
									</span>
								</div>
							)
							: (
								<DebugLink
									to={`agents/${participant.id}`}
									className={`text-xs font-semibold hover:underline truncate max-w-full ${COLORS.participant[participant.role]}`}
								>
									{participant.name}
								</DebugLink>
							)}

						<div className="flex items-center gap-1.5 mt-1">
							<RoleBadge role={participant.role} />
							<StatusIndicator status={participant.status} />
						</div>
					</div>
				)
			})}
		</div>
	)
}

function UserIcon() {
	return (
		<svg className="w-3.5 h-3.5 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
		</svg>
	)
}

function RoleBadge({ role }: { role: DiagramParticipant['role'] }) {
	const config: Record<DiagramParticipant['role'], { bg: string; text: string; label: string }> = {
		user: { bg: 'bg-blue-100', text: 'text-blue-700', label: 'User' },
		communicator: { bg: 'bg-emerald-100', text: 'text-emerald-700', label: 'Comm' },
		orchestrator: { bg: 'bg-violet-100', text: 'text-violet-700', label: 'Orch' },
		worker: { bg: 'bg-slate-100', text: 'text-slate-700', label: 'Worker' },
	}

	const { bg, text, label } = config[role]

	return (
		<span className={`text-[9px] px-1.5 py-0.5 rounded-full ${bg} ${text} font-medium`}>
			{label}
		</span>
	)
}

function StatusIndicator({ status }: { status: DiagramParticipant['status'] }) {
	const config: Record<DiagramParticipant['status'], { bg: string; ring?: string; animate?: boolean }> = {
		idle: { bg: 'bg-slate-300' },
		thinking: { bg: 'bg-amber-400', ring: 'ring-amber-200', animate: true },
		responding: { bg: 'bg-blue-400', ring: 'ring-blue-200' },
		waiting_for_user: { bg: 'bg-purple-400', ring: 'ring-purple-200' },
		error: { bg: 'bg-red-400', ring: 'ring-red-200' },
		paused: { bg: 'bg-amber-400', ring: 'ring-amber-200' },
	}

	const { bg, ring, animate } = config[status]

	return (
		<span
			className={`w-1.5 h-1.5 rounded-full ${bg} ${ring ? `ring-2 ${ring}` : ''} ${animate ? 'animate-pulse' : ''}`}
			title={status.replace(/_/g, ' ')}
		/>
	)
}
