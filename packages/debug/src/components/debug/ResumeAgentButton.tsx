import { api, unwrap } from "@roj-ai/client";
import { AgentId } from "@roj-ai/shared";
import { type FormEvent, useCallback, useState } from "react";

/**
 * Resume a paused agent. Shared by DashboardPage and AgentDetailPage, which
 * each carried a byte-identical copy.
 */
export function ResumeAgentButton({
	sessionId,
	agentId,
}: {
	sessionId: string;
	agentId: string;
}) {
	const [resuming, setResuming] = useState(false);

	const handleResume = useCallback(
		async (e: FormEvent) => {
			e.stopPropagation();
			setResuming(true);
			try {
				unwrap(
					await api.call("agents.resume", {
						sessionId,
						agentId: AgentId(agentId),
					}),
				);
			} catch {
				// Error is visible via state change (or lack thereof)
			} finally {
				setResuming(false);
			}
		},
		[sessionId, agentId],
	);

	return (
		<button
			type="button"
			onClick={handleResume}
			disabled={resuming}
			className="text-[11px] font-semibold text-white bg-red-600 hover:bg-red-700 px-2.5 py-1 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0 cursor-pointer"
		>
			{resuming ? "Resuming..." : "Resume"}
		</button>
	);
}
