/**
 * @roj-ai/client
 *
 * Vanilla TypeScript client for the roj agent server. No React — React hooks
 * and chat components live in `@roj-ai/client-react`.
 */

export {
	api,
	configureApiBaseUrl,
	configureAuthToken,
	createApiClient,
	getApiBaseUrl,
	configureProjectId,
	RpcClient,
	RpcError,
	useApiError,
} from './api/client.js'
export type { ApiClient } from './api/client.js'
export { unwrap } from './api/unwrap.js'
