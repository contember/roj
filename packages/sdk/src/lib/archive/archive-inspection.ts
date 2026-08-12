import type { Result } from '~/lib/utils/result.js'
import { Err, Ok } from '~/lib/utils/result.js'
import type { ProcessRunner } from '~/platform/process.js'

const MEBIBYTE = 1024 * 1024
const ZIPINFO_TIMEOUT_MS = 60_000
const ZIPINFO_MAX_BUFFER = 10 * MEBIBYTE

export interface ArchiveLimits {
	maxEntries: number
	maxTotalUncompressedSize: number
}

export type ArchiveLimitOverrides = Partial<ArchiveLimits>

export const DEFAULT_ARCHIVE_LIMITS: Readonly<ArchiveLimits> = {
	maxEntries: 500,
	maxTotalUncompressedSize: 100 * MEBIBYTE,
}

export interface ArchiveEntry {
	name: string
	uncompressedSize: number
	type: 'file' | 'directory'
}

export interface ArchiveInspection {
	entries: readonly ArchiveEntry[]
	fileCount: number
	directoryCount: number
	totalUncompressedSize: number
}

export type ArchiveInspectionErrorCode =
	| 'aborted'
	| 'command_failed'
	| 'empty_archive'
	| 'invalid_listing'
	| 'unsafe_path'
	| 'too_many_entries'
	| 'too_large'
	| 'unsupported_entry_type'

export class ArchiveInspectionError extends Error {
	readonly code: ArchiveInspectionErrorCode
	readonly entryName?: string

	constructor(code: ArchiveInspectionErrorCode, message: string, options?: { cause?: unknown; entryName?: string }) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause })
		this.name = 'ArchiveInspectionError'
		this.code = code
		this.entryName = options?.entryName
	}
}

export interface InspectZipArchiveOptions {
	signal?: AbortSignal
	timeoutMs?: number
	limits?: ArchiveLimitOverrides
}

export function resolveArchiveLimits(overrides: ArchiveLimitOverrides = {}): Readonly<ArchiveLimits> {
	return { ...DEFAULT_ARCHIVE_LIMITS, ...overrides }
}

/** Tracks one aggregate extraction budget across a top-level archive and every nested archive. */
export class ArchiveBudget {
	readonly limits: Readonly<ArchiveLimits>
	private consumedEntries = 0
	private consumedUncompressedSize = 0

	constructor(limits: ArchiveLimitOverrides = {}) {
		this.limits = resolveArchiveLimits(limits)
	}

	consume(inspection: ArchiveInspection): Result<void, ArchiveInspectionError> {
		if (!isValidLimit(this.limits.maxEntries) || !isValidLimit(this.limits.maxTotalUncompressedSize)) {
			return invalidListing('Archive limits must be non-negative safe integers')
		}

		const nextEntries = this.consumedEntries + inspection.entries.length
		if (!Number.isSafeInteger(nextEntries) || nextEntries > this.limits.maxEntries) {
			return Err(new ArchiveInspectionError(
				'too_many_entries',
				`Nested ZIP archives exceed the aggregate ${this.limits.maxEntries} entry limit`,
			))
		}

		const nextSize = this.consumedUncompressedSize + inspection.totalUncompressedSize
		if (!Number.isSafeInteger(nextSize) || nextSize > this.limits.maxTotalUncompressedSize) {
			return Err(new ArchiveInspectionError(
				'too_large',
				`Nested ZIP archives exceed the aggregate ${this.limits.maxTotalUncompressedSize} byte uncompressed size limit`,
			))
		}

		this.consumedEntries = nextEntries
		this.consumedUncompressedSize = nextSize
		return Ok(undefined)
	}
}

/** Inspect the central directory before a caller performs extraction. */
export async function inspectZipArchive(
	process: ProcessRunner,
	archivePath: string,
	options: InspectZipArchiveOptions = {},
): Promise<Result<ArchiveInspection, ArchiveInspectionError>> {
	if (options.signal?.aborted) {
		return Err(abortedError(options.signal))
	}

	let stdout: string
	try {
		const result = await process.execFile('unzip', ['-Z', '-v', archivePath], {
			timeout: options.timeoutMs ?? ZIPINFO_TIMEOUT_MS,
			maxBuffer: ZIPINFO_MAX_BUFFER,
			signal: options.signal,
		})
		stdout = result.stdout
	} catch (cause) {
		if (options.signal?.aborted) {
			return Err(abortedError(options.signal))
		}
		// Info-ZIP uses non-zero exits for warnings; inspection fails closed on all of them.
		return Err(new ArchiveInspectionError('command_failed', 'Failed to inspect ZIP archive', { cause }))
	}

	const parsed = parseZipInfoVerbose(stdout)
	if (!parsed.ok) return parsed
	return validateArchiveEntries(parsed.value, resolveArchiveLimits(options.limits))
}

/** Parse the stable fields emitted by Info-ZIP's verbose central-directory listing. */
export function parseZipInfoVerbose(output: string): Result<readonly ArchiveEntry[], ArchiveInspectionError> {
	const normalized = output.replaceAll('\r\n', '\n')
	const countMatches = [...normalized.matchAll(/central directory contains (\d+) entr(?:y|ies)\./g)]
	if (countMatches.length !== 1) {
		return invalidListing('ZIP listing does not contain one central-directory entry count')
	}

	const expectedCountText = countMatches[0]?.[1]
	const expectedCount = expectedCountText === undefined ? Number.NaN : Number(expectedCountText)
	if (!Number.isSafeInteger(expectedCount) || expectedCount < 0) {
		return invalidListing('ZIP listing contains an invalid central-directory entry count')
	}
	if (expectedCount === 0) {
		return Err(new ArchiveInspectionError('empty_archive', 'Empty ZIP archives are not accepted'))
	}

	const markers = [...normalized.matchAll(/^Central directory entry #(\d+):\n-+\n/gm)]
	if (markers.length !== expectedCount) {
		return invalidListing(`ZIP listing declared ${expectedCount} entries but described ${markers.length}`)
	}

	const entries: ArchiveEntry[] = []
	for (let index = 0; index < markers.length; index++) {
		const marker = markers[index]
		const nextMarker = markers[index + 1]
		if (marker === undefined || marker.index === undefined) {
			return invalidListing('ZIP listing contains an entry without a location')
		}

		const declaredIndex = marker[1] === undefined ? Number.NaN : Number(marker[1])
		if (declaredIndex !== index + 1) {
			return invalidListing('ZIP listing entry numbers are not sequential')
		}

		const bodyStart = marker.index + marker[0].length
		const bodyEnd = nextMarker?.index ?? normalized.length
		const body = normalized.slice(bodyStart, bodyEnd)
		const nameMatch = /^\n {2}([^\n]*)\n\n/.exec(body)
		if (nameMatch?.[1] === undefined || nameMatch[1].length === 0) {
			return invalidListing(`ZIP listing entry #${index + 1} has no unambiguous filename`)
		}

		const name = nameMatch[1]
		const size = parseSingleIntegerField(body, 'uncompressed size')
		const filenameLength = parseSingleIntegerField(body, 'length of filename')
		if (!size.ok) return size
		if (!filenameLength.ok) return filenameLength
		if (new TextEncoder().encode(name).byteLength !== filenameLength.value) {
			return invalidListing(`ZIP listing entry #${index + 1} has an ambiguous filename`)
		}

		const type = parseEntryType(body, name)
		if (!type.ok) return type

		entries.push({
			name,
			uncompressedSize: size.value,
			type: type.value,
		})
	}

	return Ok(entries)
}

export function validateArchiveEntries(
	entries: readonly ArchiveEntry[],
	limits: Readonly<ArchiveLimits> = DEFAULT_ARCHIVE_LIMITS,
): Result<ArchiveInspection, ArchiveInspectionError> {
	if (!isValidLimit(limits.maxEntries) || !isValidLimit(limits.maxTotalUncompressedSize)) {
		return invalidListing('Archive limits must be non-negative safe integers')
	}
	if (entries.length === 0) {
		return Err(new ArchiveInspectionError('empty_archive', 'Empty ZIP archives are not accepted'))
	}
	if (entries.length > limits.maxEntries) {
		return Err(new ArchiveInspectionError(
			'too_many_entries',
			`ZIP archive exceeds the ${limits.maxEntries} entry limit`,
		))
	}

	let fileCount = 0
	let directoryCount = 0
	let totalUncompressedSize = 0

	for (const entry of entries) {
		const pathError = validateArchivePath(entry.name)
		if (pathError !== null) {
			return Err(new ArchiveInspectionError('unsafe_path', pathError, { entryName: entry.name }))
		}
		if (!isValidLimit(entry.uncompressedSize)) {
			return invalidListing(`ZIP entry has an invalid uncompressed size: ${entry.name}`)
		}

		if (entry.type === 'directory') {
			if (!entry.name.endsWith('/') || entry.uncompressedSize !== 0) {
				return Err(new ArchiveInspectionError(
					'unsupported_entry_type',
					'ZIP directory entry has an inconsistent name or size',
					{ entryName: entry.name },
				))
			}
			directoryCount++
			continue
		}

		if (entry.name.endsWith('/')) {
			return Err(new ArchiveInspectionError(
				'unsupported_entry_type',
				'ZIP regular file entry has a directory name',
				{ entryName: entry.name },
			))
		}
		fileCount++
		totalUncompressedSize += entry.uncompressedSize
		if (!Number.isSafeInteger(totalUncompressedSize) || totalUncompressedSize > limits.maxTotalUncompressedSize) {
			return Err(new ArchiveInspectionError(
				'too_large',
				`ZIP archive exceeds the ${limits.maxTotalUncompressedSize} byte uncompressed size limit`,
			))
		}
	}

	return Ok({ entries, fileCount, directoryCount, totalUncompressedSize })
}

function parseEntryType(
	body: string,
	name: string,
): Result<ArchiveEntry['type'], ArchiveInspectionError> {
	const origin = parseSingleTextField(body, 'file system or operating system of origin')
	if (!origin.ok) return origin

	let type: ArchiveEntry['type']
	if (origin.value === 'Unix') {
		const modeMatches = [...body.matchAll(/^ {2}Unix file attributes \(([0-7]{6}) octal\):\s+.*$/gm)]
		const modeText = modeMatches[0]?.[1]
		if (modeMatches.length !== 1 || modeText === undefined) {
			return invalidListing('ZIP listing entry has invalid Unix file attributes')
		}
		const kind = Number.parseInt(modeText, 8) & 0o170000
		if (kind === 0o100000) type = 'file'
		else if (kind === 0o040000) type = 'directory'
		else return unsupportedEntryType(name)
	} else if (origin.value === 'MS-DOS, OS/2 or NT FAT') {
		const attributeMatches = [...body.matchAll(/^ {2}MS-DOS file attributes \(([0-9A-Fa-f]{2}) hex\):\s+.*$/gm)]
		const attributesText = attributeMatches[0]?.[1]
		if (attributeMatches.length !== 1 || attributesText === undefined) {
			return invalidListing('ZIP listing entry has invalid MS-DOS file attributes')
		}
		const attributes = Number.parseInt(attributesText, 16)
		if ((attributes & 0x08) !== 0) return unsupportedEntryType(name)
		type = (attributes & 0x10) !== 0 ? 'directory' : 'file'
	} else {
		return unsupportedEntryType(name)
	}

	if ((type === 'directory') !== name.endsWith('/')) {
		return Err(new ArchiveInspectionError(
			'unsupported_entry_type',
			'ZIP entry name and file type are inconsistent',
			{ entryName: name },
		))
	}
	return Ok(type)
}

function parseSingleIntegerField(
	body: string,
	field: 'uncompressed size' | 'length of filename',
): Result<number, ArchiveInspectionError> {
	const expression = new RegExp(`^  ${field}:\\s+(\\d+)(?: bytes| characters)$`, 'gm')
	const matches = [...body.matchAll(expression)]
	const valueText = matches[0]?.[1]
	const value = valueText === undefined ? Number.NaN : Number(valueText)
	if (matches.length !== 1 || !Number.isSafeInteger(value) || value < 0) {
		return invalidListing(`ZIP listing entry has an invalid ${field} field`)
	}
	return Ok(value)
}

function parseSingleTextField(
	body: string,
	field: 'file system or operating system of origin',
): Result<string, ArchiveInspectionError> {
	const expression = new RegExp(`^  ${field}:\\s+(.+)$`, 'gm')
	const matches = [...body.matchAll(expression)]
	const value = matches[0]?.[1]
	if (matches.length !== 1 || value === undefined || value.length === 0) {
		return invalidListing(`ZIP listing entry has an invalid ${field} field`)
	}
	return Ok(value)
}

function validateArchivePath(name: string): string | null {
	if (name.includes('\0')) return 'ZIP entry name contains a NUL byte'
	if (name.includes('\\')) return 'ZIP entry name contains a backslash'
	if (name.startsWith('/')) return 'ZIP entry path is absolute'
	if (/^[A-Za-z]:/.test(name)) return 'ZIP entry path contains a drive prefix'

	if (name.split('/').some(segment => segment === '..')) {
		return 'ZIP entry path escapes the extraction root'
	}
	return null
}

function unsupportedEntryType(name: string): Result<never, ArchiveInspectionError> {
	return Err(new ArchiveInspectionError(
		'unsupported_entry_type',
		'ZIP archive contains a symlink or unsupported special entry',
		{ entryName: name },
	))
}

function invalidListing(message: string): Result<never, ArchiveInspectionError> {
	return Err(new ArchiveInspectionError('invalid_listing', message))
}

function isValidLimit(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0
}

function abortedError(signal: AbortSignal): ArchiveInspectionError {
	return new ArchiveInspectionError('aborted', 'ZIP archive inspection was aborted', { cause: signal.reason })
}
