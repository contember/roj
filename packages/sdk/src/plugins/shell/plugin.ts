import z from 'zod/v4'
import { definePlugin } from '~/core/plugins/plugin-builder.js'
import { createTool } from '~/core/tools/definition.js'
import { Err, Ok } from '~/lib/utils/result.js'
import { type RunCommandInput, type ShellConfig, ShellExecutor } from './executor.js'

/**
 * Extra path to bind-mount inside bwrap sandbox.
 */
export interface ExtraBind {
	/** Absolute path on the host to bind-mount */
	path: string
	/** Mount mode: 'rw' for read-write, 'ro' for read-only */
	mode: 'rw' | 'ro'
	/** Destination path inside the sandbox. Defaults to `path` (same as host). */
	destPath?: string
}

/**
 * Session-wide shell configuration.
 */
export interface ShellPresetConfig {
	/** Working directory for commands (fallback when not sandboxed and no workspace) */
	cwd: string
	/** Command timeout in milliseconds (default: 30000) */
	timeout?: number
	/** Environment variables to add/override */
	env?: Record<string, string>
	/** Shell to use (default: sh on unix, cmd.exe on windows) */
	shell?: string
	/** Whether sandbox is active */
	sandboxed?: boolean
	/** Extra paths to bind-mount inside bwrap sandbox */
	extraBinds?: ExtraBind[]
	/** Bubblewrap sandbox config (default: enabled) */
	sandbox?: {
		enabled: boolean
		/** Allow network access (default: false) */
		network?: boolean
		/** Paths with read-write access (default: [cwd]) */
		writablePaths?: string[]
	}
	/** Default enabled state for agents (default: true). Agents can override via ShellAgentConfig.enabled. */
	defaultEnabled?: boolean
}

/**
 * Agent-specific shell configuration.
 */
export interface ShellAgentConfig {
	/** Whether shell is enabled for this agent (default: true) */
	enabled?: boolean
}

const runCommandInputSchema = z.object({
	command: z.string().describe('Shell command to execute'),
	args: z.union([z.string(), z.array(z.string())]).optional()
		.describe('Command arguments. String or array of strings.'),
	cwd: z.string().optional()
		.describe('Working directory for the command.'),
	timeout: z.number().int().positive().optional()
		.describe('Command timeout in milliseconds.'),
	stdin: z.string().optional()
		.describe("Input to send to the command's stdin"),
})

export const shellPlugin = definePlugin('shell')
	.pluginConfig<ShellPresetConfig>()
	.context(async (ctx, pluginConfig) => {
		const shellConfig: ShellConfig = {
			cwd: pluginConfig.cwd,
			timeout: pluginConfig.timeout,
			env: pluginConfig.env,
			shell: pluginConfig.shell,
			sandboxed: pluginConfig.sandboxed ?? ctx.environment.sandboxed,
			extraBinds: pluginConfig.extraBinds,
			sandbox: pluginConfig.sandbox,
		}
		const executor = new ShellExecutor(shellConfig, { fs: ctx.platform.fs, process: ctx.platform.process })
		return { executor }
	})
	.agentConfig<ShellAgentConfig>()
	.tools((ctx) => {
		const defaultEnabled = ctx.pluginConfig.defaultEnabled ?? true
		const agentEnabled = ctx.pluginAgentConfig?.enabled ?? defaultEnabled
		if (!agentEnabled) return []

		return [
			createTool({
				name: 'run_command',
				description: 'Execute a shell command. Returns stdout, stderr, and exit code.',
				input: runCommandInputSchema,
				execute: async (input, context) => {
					const executor = ctx.pluginContext.executor
					const result = await executor.execute(input, context.environment)

					if (!result.ok) return Err(result.error)

					const output = JSON.stringify(result.value, null, 2)
					if (result.value.exitCode !== 0) {
						return Err({ message: output, recoverable: true })
					}
					return Ok(output)
				},
			}),
		]
	})
	.build()

/** Safe shell config for typical development tasks */
export function createSafeShellConfig(cwd: string): ShellPresetConfig {
	return { cwd, timeout: 60000, sandbox: { enabled: true } }
}

/** Restrictive shell config for untrusted agents */
export function createRestrictedShellConfig(cwd: string): ShellPresetConfig {
	return { cwd, timeout: 30000, sandbox: { enabled: true } }
}
