/** `archived`: the sandbox was terminated after its state was saved, and its sessions stay readable. */
export type SandboxState = 'stopped' | 'starting' | 'running' | 'pausing' | 'paused' | 'failed' | 'archived'
