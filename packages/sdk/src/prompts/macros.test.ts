import { describe, expect, test } from 'bun:test'
import { agentVars, processPromptMacros } from './macros.js'

describe('processPromptMacros', () => {
	test('includes content when variable is true', () => {
		const result = processPromptMacros(
			'before {{#if foo}}visible{{/if}} after',
			{ foo: true },
		)
		expect(result).toBe('before visible after')
	})

	test('strips content when variable is false', () => {
		const result = processPromptMacros(
			'before {{#if foo}}hidden{{/if}} after',
			{ foo: false },
		)
		expect(result).toBe('before  after')
	})

	test('strips content when variable is missing', () => {
		const result = processPromptMacros(
			'before {{#if foo}}hidden{{/if}} after',
			{},
		)
		expect(result).toBe('before  after')
	})

	test('handles multiple blocks', () => {
		const result = processPromptMacros(
			'{{#if a}}A{{/if}} mid {{#if b}}B{{/if}}',
			{ a: true, b: false },
		)
		expect(result).toBe('A mid ')
	})

	test('handles multiline block content', () => {
		const input = `Header

{{#if feature}}
## Feature Section

Some details here.
{{/if}}

Footer`
		const result = processPromptMacros(input, { feature: true })
		expect(result).toBe(`Header


## Feature Section

Some details here.


Footer`)
	})

	test('strips multiline block when false', () => {
		const input = `Header

{{#if feature}}
## Feature Section

Some details here.
{{/if}}

Footer`
		const result = processPromptMacros(input, {})
		expect(result).toBe(`Header



Footer`)
	})

	test('handles inline usage', () => {
		const result = processPromptMacros(
			'items: apples{{#if bananas}}, bananas{{/if}}, cherries',
			{ bananas: true },
		)
		expect(result).toBe('items: apples, bananas, cherries')
	})

	test('preserves non-conditional content', () => {
		const input = 'No macros here, just plain text.'
		expect(processPromptMacros(input, { foo: true })).toBe(input)
	})

	test('handles colon-separated variable names', () => {
		const result = processPromptMacros(
			'{{#if agent:design-tokens}}tokens{{/if}}',
			{ 'agent:design-tokens': true },
		)
		expect(result).toBe('tokens')
	})
})

describe('agentVars', () => {
	test('converts agent names to prefixed vars', () => {
		const result = agentVars(['design-tokens', 'common-blocks'])
		expect(result).toEqual({
			'agent:design-tokens': true,
			'agent:common-blocks': true,
		})
	})
})
