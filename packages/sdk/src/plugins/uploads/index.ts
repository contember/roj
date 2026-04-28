/**
 * Upload module exports
 */

export { uploadsPlugin } from './plugin.js'
export type { UploadsPluginConfig } from './plugin.js'

export type { Preprocessor, PreprocessorContext, PreprocessorResult } from './preprocessor.js'

export { PreprocessorRegistry } from './preprocessor.js'

// Preprocessor implementations
export { createImageClassifierPreprocessor, type ImageClassifierConfig, ImageClassifierPreprocessor } from './preprocessors/index.js'
