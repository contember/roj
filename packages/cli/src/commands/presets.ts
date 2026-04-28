import type { RpcClient } from '@roj-ai/shared/rpc'
import { formatTable } from '../repl/formatter.js'
import { unwrap } from '../unwrap.js'

export async function presetsCommand(client: RpcClient, json: boolean): Promise<void> {
	const { presets } = unwrap(await client.call('presets.list', {}))

	if (json) {
		console.log(JSON.stringify(presets, null, 2))
		return
	}

	if (presets.length === 0) {
		console.log('No presets available.')
		return
	}

	console.log(formatTable(
		['ID', 'Name', 'Description'],
		presets.map(p => [p.id, p.name, p.description ?? '']),
	))
}
