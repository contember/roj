import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@roj-ai/client";
import { useDebugSessionId } from "../DebugNavigation.js";

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
	timestamp: string;
	level: LogLevel;
	message: string;
	[key: string]: unknown;
}

const LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

const LEVEL_STYLES: Record<LogLevel, string> = {
	debug: "text-slate-400",
	info: "text-slate-700",
	warn: "text-yellow-700 bg-yellow-50",
	error: "text-red-700 bg-red-50",
};

const BADGE_STYLES: Record<LogLevel, string> = {
	debug: "bg-slate-100 text-slate-500",
	info: "bg-blue-100 text-blue-700",
	warn: "bg-yellow-100 text-yellow-700",
	error: "bg-red-100 text-red-700",
};

function parseLogEntry(line: string): LogEntry | null {
	try {
		const parsed = JSON.parse(line) as Record<string, unknown>;
		return {
			timestamp: (parsed.timestamp as string) ?? "",
			level: (LOG_LEVELS.includes(parsed.level as LogLevel)
				? parsed.level
				: "info") as LogLevel,
			message: (parsed.message as string) ?? "",
			...parsed,
		};
	} catch {
		return null;
	}
}

export function LogsPage() {
	const sessionId = useDebugSessionId();
	const [entries, setEntries] = useState<LogEntry[]>([]);
	const [offset, setOffset] = useState(0);
	const [minLevel, setMinLevel] = useState<LogLevel>("debug");
	const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());
	const containerRef = useRef<HTMLDivElement>(null);
	const autoScrollRef = useRef(true);

	const poll = useCallback(async () => {
		if (!sessionId) return;
		try {
			const result = await api.call("logs.tail", { sessionId, since: offset });
			if (!result.ok) return;
			const data = result.value;
			if (data.lines.length > 0) {
				const newEntries = data.lines
					.map(parseLogEntry)
					.filter((e: LogEntry | null): e is LogEntry => e !== null);
				setEntries((prev) => [...prev, ...newEntries]);
			}
			setOffset(data.offset);
		} catch {
			// ignore fetch errors
		}
	}, [sessionId, offset]);

	useEffect(() => {
		poll();
		const interval = setInterval(poll, 2000);
		return () => clearInterval(interval);
	}, [poll]);

	// Auto-scroll
	useEffect(() => {
		if (autoScrollRef.current && containerRef.current) {
			containerRef.current.scrollTop = containerRef.current.scrollHeight;
		}
	});

	const handleScroll = () => {
		const el = containerRef.current;
		if (!el) return;
		const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
		autoScrollRef.current = atBottom;
	};

	const toggleRow = (index: number) => {
		setExpandedRows((prev) => {
			const next = new Set(prev);
			if (next.has(index)) {
				next.delete(index);
			} else {
				next.add(index);
			}
			return next;
		});
	};

	if (!sessionId) return null;

	const minLevelIndex = LOG_LEVELS.indexOf(minLevel);
	const filtered = entries.filter(
		(e) => LOG_LEVELS.indexOf(e.level) >= minLevelIndex,
	);

	return (
		<div className="flex flex-col h-full gap-3">
			{/* Toolbar */}
			<div className="flex items-center gap-4 text-sm shrink-0">
				<span className="text-slate-600">
					<span className="font-medium text-slate-900">{filtered.length}</span>
					{filtered.length !== entries.length && (
						<span className="text-slate-400"> / {entries.length}</span>
					)}{" "}
					lines
				</span>
				<label className="flex items-center gap-2 text-slate-600">
					Min level:
					<select
						value={minLevel}
						onChange={(e) => setMinLevel(e.target.value as LogLevel)}
						className="text-sm border border-slate-300 rounded px-2 py-1 bg-white"
					>
						{LOG_LEVELS.map((l) => (
							<option key={l} value={l}>
								{l}
							</option>
						))}
					</select>
				</label>
				<span
					className={`text-xs px-2 py-0.5 rounded-full ${autoScrollRef.current ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-500"}`}
				>
					{autoScrollRef.current ? "auto-scroll on" : "auto-scroll off"}
				</span>
			</div>

			{/* Log entries */}
			<div
				ref={containerRef}
				onScroll={handleScroll}
				className="flex-1 overflow-auto bg-white rounded-md border border-slate-200 font-mono text-xs"
			>
				{entries.length === 0 ? (
					<div className="p-4 text-slate-500 text-sm font-sans">
						No log entries yet
					</div>
				) : (
					<table className="w-full">
						<tbody>
							{filtered.map((entry) => {
								const globalIndex = entries.indexOf(entry);
								const expanded = expandedRows.has(globalIndex);
								const { timestamp, level, message, ...context } = entry;
								const hasContext = Object.keys(context).length > 0;
								const time = timestamp
									? new Date(timestamp).toLocaleTimeString()
									: "";

								return (
									<tr
										key={globalIndex}
										onClick={() => hasContext && toggleRow(globalIndex)}
										className={`border-b border-slate-100 align-top ${LEVEL_STYLES[level]} ${hasContext ? "cursor-pointer hover:bg-slate-50" : ""}`}
									>
										<td className="px-2 py-1 text-slate-400 whitespace-nowrap w-0">
											{time}
										</td>
										<td className="px-2 py-1 w-0">
											<span
												className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase ${BADGE_STYLES[level]}`}
											>
												{level}
											</span>
										</td>
										<td className="px-2 py-1 break-all">
											<div>{message}</div>
											{expanded && hasContext && (
												<pre className="mt-1 p-2 bg-slate-50 rounded border border-slate-200 text-[11px] whitespace-pre-wrap break-words">
													{JSON.stringify(context, null, 2)}
												</pre>
											)}
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				)}
			</div>
		</div>
	);
}
