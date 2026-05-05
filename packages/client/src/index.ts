/**
 * @roj-ai/client
 *
 * Vanilla TypeScript client for the roj agent server. No React — React hooks
 * and chat components live in `@roj-ai/client-react`.
 */

export {
	api,
	BatchBuilder,
	configureApiBaseUrl,
	configureAuthToken,
	createApiClient,
	getApiBaseUrl,
	configureProjectId,
	instanceApi,
	RpcClient,
	RpcError,
	useApiError,
} from './api/client.js'
export type { ApiClient, BatchEntry, InstanceApiClient } from './api/client.js'
export { unwrap } from './api/unwrap.js'
