/**
 * Shell plugin - command execution with sandbox support
 */

export {
	createSandboxedShellConfig,
	type ExtraBind as ShellExtraBind,
	type ShellAgentConfig,
	shellPlugin,
	type ShellPresetConfig,
} from './plugin.js'

export {
	type ExtraBind,
	type RunCommandInput,
	type SandboxConfig,
	type ShellConfig,
	ShellExecutor,
	type ShellResult,
} from './executor.js'
