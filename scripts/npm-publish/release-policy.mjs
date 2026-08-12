import { spawnSync } from 'node:child_process'

const parseJsonOutput = (stdout, description) => {
	const value = stdout.trim()
	if (!value) return undefined
	try {
		return JSON.parse(value)
	} catch {
		throw new Error(`npm returned invalid JSON for ${description}`)
	}
}

const isNotFound = (result) => /(?:\bE404\b|404 Not Found)/i.test(`${result.stderr}\n${result.stdout}`)

export const runNpm = (args, options = {}) => spawnSync(process.env.ROJ_NPM_COMMAND ?? 'npm', args, {
	encoding: 'utf8',
	...options,
})

const queryNpm = (args, description, runner) => {
	const result = runner(args)
	if (result.error) throw result.error
	if (result.status !== 0) {
		if (isNotFound(result)) return { found: false }
		throw new Error(`npm query failed for ${description}: ${result.stderr.trim() || `exit ${result.status}`}`)
	}
	return { found: true, value: parseJsonOutput(result.stdout, description) }
}

export const getPublishedIntegrity = (name, version, runner = runNpm) => {
	const result = queryNpm(['view', `${name}@${version}`, 'dist.integrity', '--json'], `${name}@${version}`, runner)
	if (!result.found) return undefined
	if (typeof result.value !== 'string' || !result.value.startsWith('sha512-')) {
		throw new Error(`${name}@${version} exists without a usable sha512 integrity`)
	}
	return result.value
}

export const getDistTagVersion = (name, tag, runner = runNpm) => {
	const result = queryNpm(['view', name, 'dist-tags', '--json'], `${name} dist-tags`, runner)
	if (!result.found || result.value === undefined || result.value === null) return undefined
	if (typeof result.value !== 'object' || Array.isArray(result.value)) {
		throw new Error(`${name} dist-tags metadata is not an object`)
	}
	const version = result.value[tag]
	if (version === undefined) return undefined
	if (typeof version !== 'string') throw new Error(`${name} dist-tag ${tag} is not a version string`)
	return version
}

export const parseSemver = (value) => {
	const match = value.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/)
	if (!match) return undefined
	return {
		major: match[1],
		minor: match[2],
		patch: match[3],
		prerelease: match[4]?.split('.'),
	}
}

const compareNumericIdentifier = (left, right) => {
	if (left.length !== right.length) return left.length < right.length ? -1 : 1
	if (left === right) return 0
	return left < right ? -1 : 1
}

const compareIdentifier = (left, right) => {
	const leftNumeric = /^\d+$/.test(left)
	const rightNumeric = /^\d+$/.test(right)
	if (leftNumeric && rightNumeric) return compareNumericIdentifier(left, right)
	if (leftNumeric) return -1
	if (rightNumeric) return 1
	if (left === right) return 0
	return left < right ? -1 : 1
}

export const compareSemver = (leftValue, rightValue) => {
	const left = parseSemver(leftValue)
	const right = parseSemver(rightValue)
	if (!left || !right) throw new Error(`Cannot compare invalid semver: ${leftValue}, ${rightValue}`)
	for (const key of ['major', 'minor', 'patch']) {
		const comparison = compareNumericIdentifier(left[key], right[key])
		if (comparison !== 0) return comparison
	}
	if (!left.prerelease && !right.prerelease) return 0
	if (!left.prerelease) return 1
	if (!right.prerelease) return -1
	for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index++) {
		if (left.prerelease[index] === undefined) return -1
		if (right.prerelease[index] === undefined) return 1
		const comparison = compareIdentifier(left.prerelease[index], right.prerelease[index])
		if (comparison !== 0) return comparison
	}
	return 0
}

export const assertDistTagCanAdvance = ({ candidate, current, tag }) => {
	const candidateVersion = parseSemver(candidate)
	if (!candidateVersion) throw new Error(`Invalid candidate version: ${candidate}`)
	// latest is stable-only; other tags accept semver but still cannot regress.
	if (tag === 'latest' && candidateVersion.prerelease) {
		throw new Error(`Refusing to assign stable dist-tag latest to prerelease ${candidate}`)
	}
	if (current === undefined) return
	if (!parseSemver(current)) throw new Error(`Current ${tag} dist-tag is not valid semver: ${current}`)
	if (compareSemver(candidate, current) < 0) {
		throw new Error(`Refusing to move ${tag} dist-tag backward from ${current} to ${candidate}`)
	}
}

export const decidePublish = (entry, tag, runner = runNpm) => {
	const publishedIntegrity = getPublishedIntegrity(entry.name, entry.version, runner)
	if (publishedIntegrity !== undefined) {
		if (publishedIntegrity !== entry.integrity) {
			throw new Error(`${entry.name}@${entry.version} already exists with different artifact integrity`)
		}
		return { action: 'skip', reason: 'identical artifact already published' }
	}
	const current = getDistTagVersion(entry.name, tag, runner)
	assertDistTagCanAdvance({ candidate: entry.version, current, tag })
	return { action: 'publish', current }
}
