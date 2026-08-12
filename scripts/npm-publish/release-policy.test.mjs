import { describe, expect, test } from 'bun:test'
import {
	assertDistTagCanAdvance,
	compareSemver,
	decidePublish,
	getPublishedIntegrity,
} from './release-policy.mjs'

const response = (status, value, stderr = '') => ({
	status,
	stdout: value === undefined ? '' : `${JSON.stringify(value)}\n`,
	stderr,
})

const registry = (responses) => {
	const calls = []
	return {
		calls,
		run: (args) => {
			calls.push(args)
			const next = responses.shift()
			if (!next) throw new Error(`Unexpected npm call: ${args.join(' ')}`)
			return next
		},
	}
}

describe('release policy', () => {
	test('resumes by skipping an identical published artifact', () => {
		const mock = registry([response(0, 'sha512-identical')])
		expect(decidePublish({
			name: '@roj-ai/sdk',
			version: '1.2.3',
			integrity: 'sha512-identical',
		}, 'latest', mock.run)).toEqual({
			action: 'skip',
			reason: 'identical artifact already published',
		})
		expect(mock.calls).toHaveLength(1)
	})

	test('rejects resume when registry integrity differs', () => {
		const mock = registry([response(0, 'sha512-other')])
		expect(() => decidePublish({
			name: '@roj-ai/sdk',
			version: '1.2.3',
			integrity: 'sha512-local',
		}, 'latest', mock.run)).toThrow('different artifact integrity')
	})

	test('publishes an absent version without moving a tag backward', () => {
		const mock = registry([
			response(1, undefined, 'npm error code E404'),
			response(0, { latest: '1.2.2' }),
		])
		expect(decidePublish({
			name: '@roj-ai/sdk',
			version: '1.2.3',
			integrity: 'sha512-local',
		}, 'latest', mock.run)).toEqual({ action: 'publish', current: '1.2.2' })
	})

	test('allows an absent dist-tag', () => {
		const mock = registry([
			response(1, undefined, 'npm error code E404'),
			response(0, { latest: '1.2.2' }),
		])
		expect(decidePublish({
			name: '@roj-ai/sdk',
			version: '1.2.3',
			integrity: 'sha512-local',
		}, 'next', mock.run)).toEqual({ action: 'publish', current: undefined })
	})

	test('refuses stable and prerelease tag regressions', () => {
		expect(() => assertDistTagCanAdvance({ candidate: '1.2.2', current: '1.2.3', tag: 'latest' }))
			.toThrow('backward')
		expect(() => assertDistTagCanAdvance({ candidate: '2.0.0-next.1', current: undefined, tag: 'latest' }))
			.toThrow('stable dist-tag latest')
		expect(() => assertDistTagCanAdvance({ candidate: '2.0.0-next.1', current: '2.0.0-next.2', tag: 'next' }))
			.toThrow('backward')
	})

	test('orders semver prereleases before stable releases', () => {
		expect(compareSemver('2.0.0-next.2', '2.0.0-next.10')).toBeLessThan(0)
		expect(compareSemver('2.0.0-next.10', '2.0.0')).toBeLessThan(0)
	})

	test('implements SemVer precedence without locale or number precision errors', () => {
		const precedence = [
			'1.0.0-alpha',
			'1.0.0-alpha.1',
			'1.0.0-alpha.beta',
			'1.0.0-beta',
			'1.0.0-beta.2',
			'1.0.0-beta.11',
			'1.0.0-rc.1',
			'1.0.0',
		]
		for (let index = 1; index < precedence.length; index++) {
			expect(compareSemver(precedence[index - 1], precedence[index])).toBeLessThan(0)
		}
		expect(compareSemver('1.0.0-A', '1.0.0-a')).toBeLessThan(0)
		expect(compareSemver('1.0.0-9007199254740992', '1.0.0-9007199254740993')).toBeLessThan(0)
		expect(compareSemver('9007199254740992.0.0', '9007199254740993.0.0')).toBeLessThan(0)
	})

	test('rejects leading zeroes and malformed build metadata', () => {
		expect(() => compareSemver('01.0.0', '1.0.0')).toThrow('invalid semver')
		expect(() => compareSemver('1.0.0-alpha.01', '1.0.0-alpha.1')).toThrow('invalid semver')
		expect(() => compareSemver('1.0.0+build..1', '1.0.0')).toThrow('invalid semver')
	})

	test('does not treat registry failures as an absent version', () => {
		const mock = registry([response(1, undefined, 'npm error code E500')])
		expect(() => getPublishedIntegrity('@roj-ai/sdk', '1.2.3', mock.run)).toThrow('npm query failed')
	})
})
