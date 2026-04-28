// ============================================================================
// JSON Schema
// ============================================================================

/**
 * JSON Schema type (simplified for tool parameters)
 *
 * Note: Index signature included for compatibility with LLM SDK types
 * (e.g., OpenRouter SDK's ToolDefinitionJsonFunction.parameters)
 */
export interface JSONSchema {
	type: 'object' | 'string' | 'number' | 'boolean' | 'array'
	properties?: Record<string, JSONSchema>
	items?: JSONSchema
	required?: string[]
	description?: string
	enum?: string[]
	/** Additional schema properties for extensibility */
	[key: string]: unknown
}
