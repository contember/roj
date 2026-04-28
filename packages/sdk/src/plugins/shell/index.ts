/**
 * Shell plugin - command execution with sandbox support
 */

export {
	createRestrictedShellConfig,
	createSafeShellConfig,
	type ExtraBind as ShellExtraBind,
	type ShellAgentConfig,
	shellPlugin,
	type ShellPresetConfig,
} from './plugin.js'

export {
	buildBwrapArgs,
	type BwrapOptions,
	type ExtraBind,
	type RunCommandInput,
	type SandboxConfig,
	type ShellConfig,
	ShellExecutor,
	type ShellResult,
} from './executor.js'
