import { join } from 'node:path'
import type { Logger } from '~/lib/logger/logger.js'
import type { FileSystem } from '~/platform/fs.js'

export interface PostInjectExecOptions {
	cwd?: string
	timeout?: number
	env?: Record<string, string>
}

export interface PostInjectContext {
	targetDir: string
	sessionDir: string
	paths: string[]
	filename: string
	mimeType: string
	logger: Logger
	exec(
		cmd: string,
		args: string[],
		options?: PostInjectExecOptions,
	): Promise<{ stdout: string; stderr: string }>
	fs: FileSystem
}

export type PostInjectHook = (ctx: PostInjectContext) => Promise<void>

export interface PostInjectRule {
	/** Log label — defaults to the command string. */
	name?: string
	/** Relative path (inside `cwd`) that must exist for the rule to fire. Omit to always run. */
	when?: string
	/** Working directory — `target` (default) = injection targetDir, `session` = sessionDir. */
	cwd?: 'target' | 'session'
	/** Command + args. */
	run: [string, ...string[]]
	/** Environment overrides, merged into process.env. */
	env?: Record<string, string>
	/** Command timeout in ms. Default 300000 (5 min). */
	timeoutMs?: number
	/** If false, a failing rule throws and aborts subsequent rules. Default: true (warn + continue). */
	continueOnError?: boolean
}

export function postInjectRules(rules: PostInjectRule[]): PostInjectHook {
	return async (ctx) => {
		for (const rule of rules) {
			const cwd = rule.cwd === 'session' ? ctx.sessionDir : ctx.targetDir

			if (rule.when) {
				const probe = join(cwd, rule.when)
				const exists = await ctx.fs.exists(probe)
				if (!exists) continue
			}

			const label = rule.name ?? rule.run.join(' ')
			ctx.logger.info(`resources.postInject: running "${label}"`, { cwd })

			const [cmd, ...args] = rule.run
			try {
				await ctx.exec(cmd, args, {
					cwd,
					timeout: rule.timeoutMs ?? 300_000,
					env: rule.env,
				})
				ctx.logger.info(`resources.postInject: "${label}" completed`, { cwd })
			} catch (err) {
				const error = err instanceof Error ? err.message : String(err)
				if (rule.continueOnError === false) throw err
				ctx.logger.warn(`resources.postInject: "${label}" failed`, { cwd, error })
			}
		}
	}
}
