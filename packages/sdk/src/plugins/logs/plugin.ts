import { resolve } from 'node:path'
import z from 'zod/v4'
import { definePlugin } from '~/core/plugins/plugin-builder.js'
import { Ok } from '~/lib/utils/result.js'

export const logsPlugin = definePlugin('logs')
	.method('tail', {
		input: z.object({ since: z.number().int().min(0).optional() }),
		output: z.object({ lines: z.array(z.string()), offset: z.number() }),
		handler: async (ctx, input) => {
			const since = input.since ?? 0
			const logPath = resolve(ctx.environment.sessionDir, 'session.log')

			let fileSize: number
			try {
				const st = await ctx.platform.fs.stat(logPath)
				fileSize = st.size
			} catch {
				return Ok({ lines: [], offset: 0 })
			}

			if (since >= fileSize) {
				return Ok({ lines: [], offset: fileSize })
			}

			const fh = await ctx.platform.fs.open(logPath, 'r')
			try {
				const length = fileSize - since
				const buf = Buffer.alloc(length)
				await fh.read(buf, 0, length, since)
				const text = buf.toString('utf-8')
				const lines = text.split('\n').filter((l) => l.length > 0)
				return Ok({ lines, offset: fileSize })
			} finally {
				await fh.close()
			}
		},
	})
	.build()
