/** Main module of the loaded worker. `roj-app-bundle` is the app's `roj build` output, added by the host. */

import appConfig from 'roj-app-bundle'
import { createRuntimeFacet } from './facet.js'

export const Runtime = createRuntimeFacet(appConfig)
