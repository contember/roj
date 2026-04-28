---
name: e2b-sandbox-debug
description: Spawn E2B sandbox for debugging and testing tools/commands in the container environment.
---

# E2B Sandbox Debug

Spawn a sandbox from the `webmaster-sandbox-chrome` template to test tools, commands, or file operations in the production container environment.

## SDK

```typescript
import { Sandbox } from '@e2b/code-interpreter'
```

## Spawning a sandbox

```typescript
const sandbox = await Sandbox.betaCreate('webmaster-sandbox-chrome', {
	timeoutMs: 120_000,
})
```

- `bun` auto-loads `E2B_API_KEY` from `.env` — no need to pass `accessToken`
- Default timeout is 60s, increase for longer operations

## Running commands

```typescript
const res = await sandbox.commands.run('markitdown /tmp/test.html', {
	cwd: '/home/user/sandbox', // optional
	timeoutMs: 60_000, // optional
})
// res.exitCode, res.stdout, res.stderr
```

**Note:** `commands.run()` throws `CommandExitError` on non-zero exit codes. Catch it:

```typescript
try {
	const res = await sandbox.commands.run(cmd, { timeoutMs: 60_000 })
	return { stdout: res.stdout, stderr: res.stderr, exitCode: res.exitCode }
} catch (e: unknown) {
	if (e && typeof e === 'object' && 'exitCode' in e) {
		const err = e as { exitCode: number; stdout: string; stderr: string }
		return { stdout: err.stdout, stderr: err.stderr, exitCode: err.exitCode }
	}
	throw e
}
```

## File operations

```typescript
// Write file to sandbox
await sandbox.files.write('/tmp/test.html', '<h1>Hello</h1>')

// Read file from sandbox
const content = await sandbox.files.read('/tmp/test.txt', { format: 'text' })
const bytes = await sandbox.files.read('/tmp/img.png', { format: 'bytes' })
```

## Cleanup

```typescript
await sandbox.kill()
```

## Rebuilding the template

After changing `containers/templates/chrome/template.ts`:

```bash
bun run containers/templates/chrome/build.ts
```

Build takes ~3 minutes. Template alias is `webmaster-sandbox-chrome`.

## Template definition

`containers/templates/chrome/template.ts` — base image `oven/bun:slim` with:

- chromium (headless), dbus, socat, fonts
- libvips-tools (image processing)
- poppler-utils (pdftotext, pdfimages)
- pandoc (document conversion, image extraction)
- python3 + markitdown[all] (universal document→markdown)
- bash, bubblewrap, coreutils, git, ripgrep, ugrep, jq, curl, unzip, procps
- pup (HTML parser), ast-grep (code search)

## Typical test script pattern

Write a temporary `.ts` file and run with `bun run <file>.ts`. Delete after testing.

```typescript
import { Sandbox } from '@e2b/code-interpreter'

async function main() {
	const sandbox = await Sandbox.betaCreate('webmaster-sandbox-chrome', {
		timeoutMs: 120_000,
	})
	try {
		// ... run commands, write/read files, verify behavior
	} finally {
		await sandbox.kill()
	}
}
main().catch(e => {
	console.error(e)
	process.exit(1)
})
```
