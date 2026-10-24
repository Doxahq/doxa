export interface EmbeddedMetadataArtifact {
  line: number;
  snippet: string;
}

const DELIMITER_PATTERN = /^\s*-{3,}\s*$/;
const CANONICAL_DELIMITER_PATTERN = /^\s*---\s*$/;
const METADATA_KEY_PATTERN = /^\s*(title|description|keywords|icon)\s*:/;
const INLINE_METADATA_KEY_PATTERN = /(?:^|\s)(title|description|keywords|icon)\s*:/g;
const FENCE_PATTERN = /^\s*(`{3,}|~{3,})/;
const MAX_METADATA_BLOCK_LINES = 20;

export function findEmbeddedMetadataArtifact(content: string): EmbeddedMetadataArtifact | null {
  const lines = content.split(/\r?\n/);
  const startIndex = indexAfterCanonicalFrontmatter(lines);
  let fenceMarker: string | null = null;

  for (let index = startIndex; index < lines.length; index++) {
    const fence = FENCE_PATTERN.exec(lines[index]);
    if (fence) {
      const marker = fence[1][0];
      if (fenceMarker === null) {
        fenceMarker = marker;
      } else if (fenceMarker === marker) {
        fenceMarker = null;
      }
      continue;
    }

    if (fenceMarker !== null) continue;

    if (hasInlineMetadataArtifact(lines[index])) {
      return { line: index + 1, snippet: lines[index] };
    }

    const metadataRun = findMetadataLineRun(lines, index);
    if (metadataRun) {
      return {
        line: index + 1,
        snippet: lines.slice(index, metadataRun.endIndex).join("\n"),
      };
    }

    if (!DELIMITER_PATTERN.test(lines[index])) continue;

    const closingIndex = findClosingDelimiter(lines, index + 1);
    if (closingIndex === null) continue;

    const keyCount = lines
      .slice(index + 1, closingIndex)
      .filter((line) => METADATA_KEY_PATTERN.test(line)).length;
    if (keyCount < 2) continue;

    return {
      line: index + 1,
      snippet: lines.slice(index, closingIndex + 1).join("\n"),
    };
  }

  return null;
}

function hasInlineMetadataArtifact(line: string): boolean {
  if (!METADATA_KEY_PATTERN.test(line)) return false;

  const keys = new Set(
    Array.from(line.matchAll(INLINE_METADATA_KEY_PATTERN), (match) => match[1]),
  );
  return keys.size >= 2;
}

function findMetadataLineRun(
  lines: string[],
  startIndex: number,
): { endIndex: number } | null {
  if (!METADATA_KEY_PATTERN.test(lines[startIndex])) return null;

  let endIndex = startIndex;
  const keys = new Set<string>();
  while (
    endIndex < lines.length &&
    endIndex < startIndex + MAX_METADATA_BLOCK_LINES &&
    METADATA_KEY_PATTERN.test(lines[endIndex])
  ) {
    const match = METADATA_KEY_PATTERN.exec(lines[endIndex]);
    if (match) keys.add(match[1]);
    endIndex += 1;
  }

  return keys.size >= 2 ? { endIndex } : null;
}

function indexAfterCanonicalFrontmatter(lines: string[]): number {
  if (!CANONICAL_DELIMITER_PATTERN.test(lines[0] ?? "")) return 0;

  for (let index = 1; index < lines.length; index++) {
    if (CANONICAL_DELIMITER_PATTERN.test(lines[index])) return index + 1;
  }

  return 0;
}

function findClosingDelimiter(lines: string[], startIndex: number): number | null {
  const endIndex = Math.min(lines.length, startIndex + MAX_METADATA_BLOCK_LINES);
  for (let index = startIndex; index < endIndex; index++) {
    if (DELIMITER_PATTERN.test(lines[index])) return index;
  }

  return null;
}
