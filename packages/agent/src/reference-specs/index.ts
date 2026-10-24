export { discoverSpecFiles } from "./discovery";
export { readSpecFile } from "./file-gate";
export { checkSpecReaderOutput, specReaderOutputSchema } from "./output-schema";
export {
  readRepositorySpecs,
  type RepositorySpecRead,
  type RepositorySpecReadOptions,
} from "./reader";
export { sanitizeSpecMarkdown, sanitizeSpecPlainText } from "./spec-text";
export { buildSpecSurface } from "./surface";
