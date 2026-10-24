import { syntaxFor } from "../languages";
import { maskSource } from "../mask";
import type { FileExtraction, RepoMapLanguage, SourceFileInput, SymbolExtractor } from "../types";
import { extractGeneric } from "./generic";
import { extractGo } from "./go";
import { extractJavaScript } from "./javascript";
import { extractPython } from "./python";
import { extractRust } from "./rust";
import { LexedSource } from "./shared";

const EXTRACTORS: Readonly<Record<RepoMapLanguage, (lexed: LexedSource) => FileExtraction>> = {
  typescript: extractJavaScript,
  javascript: extractJavaScript,
  python: extractPython,
  go: extractGo,
  rust: extractRust,
  generic: extractGeneric,
};

/**
 * Regex-over-masked-source extractor. Masking removes comments and string
 * bodies first, so declarations are matched only in real code. A syntax-tree
 * extractor can replace it through {@link SymbolExtractor}.
 */
export const lexicalSymbolExtractor: SymbolExtractor = {
  version: "lexical-v1",
  extract(file: SourceFileInput): FileExtraction {
    const masked = maskSource(file.content, syntaxFor(file.language, file.path));
    return EXTRACTORS[file.language](new LexedSource(file.content, masked));
  },
};
