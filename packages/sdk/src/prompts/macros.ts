const BLOCK_RE = /\{\{#if ([\w:.-]+)\}\}([\s\S]*?)\{\{\/if\}\}/g

/**
 * Process simple conditional macros in prompt templates.
 *
 * Syntax: `{{#if varName}}...content...{{/if}}`
 * - If `vars[varName]` is `true`, the content is kept (tags removed).
 * - Otherwise the entire block (including tags) is stripped.
 */
export function processPromptMacros(prompt: string, vars: Record<string, boolean>): string {
	return prompt.replace(BLOCK_RE, (_, name: string, content: string) => {
		return vars[name] ? content : ''
	})
}

/**
 * Convert an array of agent names into macro variables.
 *
 * `['design-tokens', 'common-blocks']` → `{ 'agent:design-tokens': true, 'agent:common-blocks': true }`
 */
export function agentVars(agents: readonly string[]): Record<string, boolean> {
	const vars: Record<string, boolean> = {}
	for (const agent of agents) {
		vars[`agent:${agent}`] = true
	}
	return vars
}
