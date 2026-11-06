import { nextFenceState, type FenceState } from "./markdown-fences";

export interface RestEndpointDuplicateSection {
  readonly heading: string;
  readonly level: 2 | 3;
  /** Zero-based line index within the page body. */
  readonly line: number;
  readonly source: string;
}

const DUPLICATE_SECTION_HEADINGS = new Set([
  "endpoint",
  "request",
  "request body",
  "response",
  "responses",
  "authentication",
  "authorization",
  "parameters",
  "path parameters",
  "query parameters",
  "body",
  "errors",
  "example",
  "examples",
]);

export function findRestEndpointDuplicateSection(
  body: string,
): RestEndpointDuplicateSection | null {
  const lines = body.split("\n");
  let fence: FenceState | undefined;

  for (let line = 0; line < lines.length; line += 1) {
    const source = lines[line] ?? "";
    fence = nextFenceState(source, fence);
    if (fence) continue;

    const heading = parseHeading(source);
    if (heading && DUPLICATE_SECTION_HEADINGS.has(heading.text.toLowerCase())) {
      return {
        heading: heading.text,
        level: heading.level,
        line,
        source,
      };
    }
  }

  return null;
}

interface ParsedHeading {
  readonly level: 2 | 3;
  readonly text: string;
}

function parseHeading(line: string): ParsedHeading | null {
  const match = /^(#{2,3})\s+(.+?)\s*$/.exec(line);
  if (!match) return null;

  const text = (match[2] ?? "").replace(/\s+#+\s*$/, "").trim();
  return {
    level: match[1]?.length === 2 ? 2 : 3,
    text,
  };
}
