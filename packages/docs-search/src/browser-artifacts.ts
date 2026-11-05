import type { SearchIndexLine } from "./contracts";

/** Longest stored line. A result shows at most 180 characters of one line. */
const MAX_SNIPPET_LINE_LENGTH = 400;
const MAX_SUMMARY_LENGTH = 160;

export interface BrowserSearchFiles {
  /** The serialized MiniSearch index, without snippet text. */
  index: string;
  /** JSON: the snippet lines of each document, by document ID. */
  snippets: string;
}

/**
 * Builds the two files that a browser downloads from a version's compiled
 * index. Snippet text is about half of the compressed size, so it has its own
 * file: on a slow connection search starts with the smaller file.
 *
 * It reads the stored fields only and builds no index, so it is cheap to run at
 * the edge. Published files never change, so this works for every version.
 * Returns null for a file of another shape.
 */
export function splitCompiledSearchIndex(
  compiledArtifact: string,
): BrowserSearchFiles | null {
  const serialized = readSerializedIndex(compiledArtifact);
  if (!serialized) return null;

  const index = serialized.index as {
    documentIds?: Record<string, unknown>;
    storedFields?: Record<string, Record<string, unknown>>;
  };
  if (!index.documentIds || !index.storedFields) return null;

  const snippets: Record<string, SearchIndexLine[]> = {};
  for (const [shortId, stored] of Object.entries(index.storedFields)) {
    const lines = readLines(stored.lines);
    delete stored.lines;
    const summary = lines.find((line) => line.text.trim())?.text;
    if (summary) stored.description = summary.slice(0, MAX_SUMMARY_LENGTH);
    const documentId = index.documentIds[shortId];
    if (typeof documentId === "string") snippets[documentId] = lines;
  }

  return {
    index: JSON.stringify(index),
    snippets: JSON.stringify(snippets),
  };
}

function readSerializedIndex(
  compiledArtifact: string,
): { index: unknown } | null {
  try {
    const artifact: unknown = JSON.parse(compiledArtifact);
    if (
      !artifact ||
      typeof artifact !== "object" ||
      !("serializedIndex" in artifact) ||
      typeof artifact.serializedIndex !== "string"
    ) {
      return null;
    }
    const index: unknown = JSON.parse(artifact.serializedIndex);
    return index && typeof index === "object" ? { index } : null;
  } catch {
    return null;
  }
}

function readLines(value: unknown): SearchIndexLine[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((line: unknown): SearchIndexLine[] => {
    if (!line || typeof line !== "object" || !("text" in line)) return [];
    if (typeof line.text !== "string") return [];
    return [
      {
        text: line.text.slice(0, MAX_SNIPPET_LINE_LENGTH),
        ...("anchor" in line && typeof line.anchor === "string"
          ? { anchor: line.anchor }
          : {}),
      },
    ];
  });
}
