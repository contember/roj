/**
 * What the just-bash shell backend actually implements.
 *
 * `just-bash` is a subset of bash, so the plan's Phase 3 needs the commands
 * roj shells out to audited rather than assumed. Probes run through both entry
 * points: `platform.process.execFile`, which quotes an argv back into a command
 * line, and a raw `runtime.exec` for the shell syntax execFile cannot express.
 */

import type { Workspace } from '@cloudflare/computer'
import type { Platform } from '@roj-ai/sdk/platform'

const PROBE_DIR = '/probe'

/** Commands the SDK's plugins reach for, plus the coreutils they would lean on. */
const EXEC_FILE_PROBES: readonly (readonly [string, ...string[]])[] = [
	['echo', 'hello'],
	['cat', `${PROBE_DIR}/a.txt`],
	['ls', PROBE_DIR],
	['ls', '-la', PROBE_DIR],
	['pwd'],
	['grep', 'needle', `${PROBE_DIR}/a.txt`],
	['grep', '-r', 'needle', PROBE_DIR],
	['head', '-n', '1', `${PROBE_DIR}/a.txt`],
	['tail', '-n', '1', `${PROBE_DIR}/a.txt`],
	['wc', '-l', `${PROBE_DIR}/a.txt`],
	['sed', 's/needle/thread/', `${PROBE_DIR}/a.txt`],
	['awk', '{print $1}', `${PROBE_DIR}/a.txt`],
	['find', PROBE_DIR, '-name', '*.txt'],
	['mkdir', '-p', `${PROBE_DIR}/nested/deep`],
	['cp', `${PROBE_DIR}/a.txt`, `${PROBE_DIR}/copy.txt`],
	['mv', `${PROBE_DIR}/copy.txt`, `${PROBE_DIR}/moved.txt`],
	['rm', '-rf', `${PROBE_DIR}/nested`],
	['env'],
	['which', 'git'],
	['sh', '-c', 'echo via-sh'],
	['bash', '-c', 'echo via-bash'],
	['git', '--version'],
	['git', 'status', '--porcelain'],
	['node', '--version'],
	['python3', '--version'],
	['unzip', '-v'],
	['pdftotext', '-v'],
]

/** Shell syntax, which execFile quotes away — these must go through the backend raw. */
const SHELL_PROBES: readonly string[] = [
	'echo hi | cat',
	'cat /probe/a.txt | grep needle | wc -l',
	'echo written > /probe/redirect.txt && cat /probe/redirect.txt',
	'echo appended >> /probe/redirect.txt; wc -l < /probe/redirect.txt',
	'true && echo and-ok || echo or-ok',
	'echo $((1 + 2))',
	'NAME=world; echo "hello $NAME"',
	'echo "$(cat /probe/a.txt | head -n 1)"',
	'for i in 1 2 3; do echo $i; done',
	'if [ -f /probe/a.txt ]; then echo exists; fi',
	'ls /probe/*.txt',
	'cd /probe && pwd',
	'export FOO=bar && env | grep FOO',
	'echo one; echo two & wait',
]

export interface ProbeResult {
	via: 'execFile' | 'exec'
	command: string
	ok: boolean
	exitCode?: number
	stdout?: string
	stderr?: string
	error?: string
}

export interface ShellProbeResult {
	probes: ProbeResult[]
	failed: string[]
}

function clip(text: string): string {
	const trimmed = text.trim()
	return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed
}

async function seed(platform: Platform): Promise<void> {
	await platform.fs.mkdir(PROBE_DIR, { recursive: true })
	await platform.fs.writeFile(`${PROBE_DIR}/a.txt`, 'first line with a needle\nsecond line\nthird line\n')
	await platform.fs.writeFile(`${PROBE_DIR}/b.txt`, 'no match here\n')
}

async function probeExecFile(platform: Platform, argv: readonly [string, ...string[]]): Promise<ProbeResult> {
	const [file, ...args] = argv
	const command = argv.join(' ')
	try {
		const { stdout, stderr } = await platform.process.execFile(file, args)
		return { via: 'execFile', command, ok: true, exitCode: 0, stdout: clip(stdout), stderr: clip(stderr) }
	} catch (error) {
		return { via: 'execFile', command, ok: false, error: clip(error instanceof Error ? error.message : String(error)) }
	}
}

async function probeExec(workspace: Workspace, backend: string, command: string): Promise<ProbeResult> {
	try {
		const handle = await workspace.runtime.exec(command, { backend, encoding: 'utf8' })
		try {
			const result = await handle.result()
			return {
				via: 'exec',
				command,
				ok: result.status === 'completed' && result.exitCode === 0,
				exitCode: result.exitCode,
				stdout: clip(result.stdout),
				stderr: clip(result.stderr),
			}
		} finally {
			handle[Symbol.dispose]()
		}
	} catch (error) {
		return { via: 'exec', command, ok: false, error: clip(error instanceof Error ? error.message : String(error)) }
	}
}

export async function runShellProbes(options: {
	platform: Platform
	workspace: Workspace
	backend: string
	/** Ad-hoc command to run instead of the suite. */
	command: string | null
}): Promise<ShellProbeResult> {
	const { platform, workspace, backend, command } = options
	await seed(platform)

	if (command !== null) {
		const probe = await probeExec(workspace, backend, command)
		return { probes: [probe], failed: probe.ok ? [] : [command] }
	}

	const probes: ProbeResult[] = []
	for (const argv of EXEC_FILE_PROBES) probes.push(await probeExecFile(platform, argv))
	for (const source of SHELL_PROBES) probes.push(await probeExec(workspace, backend, source))

	return { probes, failed: probes.filter((probe) => !probe.ok).map((probe) => probe.command) }
}
