declare namespace Cloudflare {
	interface GlobalProps {
		mainModule: typeof import('./host')
		durableNamespaces: 'InstanceDO'
	}
}

/** Written by the e2e test before wrangler starts: the `RuntimeModules` from `../src/build`. */
declare module '*/modules.json' {
	const value: { mainModule: string; modules: Record<string, string | { js: string }> }
	export default value
}
