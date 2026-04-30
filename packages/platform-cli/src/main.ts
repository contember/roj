#!/usr/bin/env bun

import { build } from './build.js'
import { uploadResource } from './resource.js'
import { upload } from './upload.js'

function getArg(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag)
	return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined
}

const [command, ...args] = process.argv.slice(2)

switch (command) {
	case 'build': {
		const configPath = args.find((a: string) => !a.startsWith('--')) ?? 'roj.config.ts'
		const out = getArg(args, '--out') ?? 'dist/bundle.js'
		await build(configPath, out)
		break
	}

	case 'upload': {
		const bundlePath = args.find((a: string) => !a.startsWith('--'))
		if (!bundlePath) {
			console.error('Usage: roj upload <bundle.js> --name <name> [--url <url>] [--api-key <key>]')
			process.exit(1)
		}
		const url = getArg(args, '--url') ?? process.env.ROJ_PLATFORM_URL
		const apiKey = getArg(args, '--api-key') ?? process.env.ROJ_API_KEY
		const name = getArg(args, '--name')
		if (!url || !apiKey || !name) {
			console.error('Missing --url, --api-key, or --name (or set ROJ_PLATFORM_URL / ROJ_API_KEY)')
			process.exit(1)
		}
		await upload(bundlePath, { url, apiKey, name })
		break
	}

	case 'deploy': {
		const configPath = args.find((a: string) => !a.startsWith('--')) ?? 'roj.config.ts'
		const out = getArg(args, '--out') ?? 'dist/bundle.js'
		const url = getArg(args, '--url') ?? process.env.ROJ_PLATFORM_URL
		const apiKey = getArg(args, '--api-key') ?? process.env.ROJ_API_KEY
		const name = getArg(args, '--name')
		if (!url || !apiKey || !name) {
			console.error('Missing --url, --api-key, or --name')
			process.exit(1)
		}
		await build(configPath, out)
		await upload(out, { url, apiKey, name })
		break
	}

	case 'resource': {
		const path = args.find((a: string) => !a.startsWith('--'))
		if (!path) {
			console.error('Usage: roj resource <path-or-dir> --slug <slug> [--name <name>] [--description <desc>] [--label <label>]')
			process.exit(1)
		}
		const url = getArg(args, '--url') ?? process.env.ROJ_PLATFORM_URL
		const apiKey = getArg(args, '--api-key') ?? process.env.ROJ_API_KEY
		const slug = getArg(args, '--slug')
		if (!url || !apiKey || !slug) {
			console.error('Missing --url, --api-key, or --slug (or set ROJ_PLATFORM_URL / ROJ_API_KEY)')
			process.exit(1)
		}
		await uploadResource(path, {
			url,
			apiKey,
			slug,
			name: getArg(args, '--name'),
			description: getArg(args, '--description'),
			label: getArg(args, '--label'),
		})
		break
	}

	default:
		console.log(`roj - Roj Platform CLI

Commands:
  build [config]                Bundle agent config into single JS
  upload <bundle> --name <n>    Upload bundle to platform
  deploy [config] --name <n>    Build + upload
  resource <path> --slug <s>    Upload file/dir as resource (dirs are zipped)

Options:
  --out <path>         Output path (default: dist/bundle.js)
  --url <url>          Platform URL (or ROJ_PLATFORM_URL env)
  --api-key <key>      API key (or ROJ_API_KEY env)
  --name <name>        Bundle/resource name
  --slug <slug>        Resource slug (unique per org)
  --description <d>    Resource description
  --label <label>      Revision label
  --version <ver>      Bundle version (optional)`)
		break
}
