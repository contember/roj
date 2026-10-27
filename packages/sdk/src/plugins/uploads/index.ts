/**
 * Upload module exports
 */

export { uploadsPlugin } from './plugin.js'
export type { UploadsPluginConfig } from './plugin.js'

export type { Preprocessor, PreprocessorContext, PreprocessorResult, UploadArtifact, UploadCapabilities } from './preprocessor.js'

export { PreprocessorRegistry } from './preprocessor.js'

export { fileUploadSource } from './source.js'
export type { UploadBlobContext, UploadBlobStore, UploadSource } from './source.js'

// Preprocessor implementations
export {
	createImageClassifierPreprocessor,
	type ImageClassifierConfig,
	ImageClassifierPreprocessor,
	MarkitdownPreprocessor,
	type MarkitdownPreprocessorConfig,
	PdfPreprocessor,
	type PdfPreprocessorConfig,
	ZipPreprocessor,
	type ZipPreprocessorConfig,
} from './preprocessors/index.js'
