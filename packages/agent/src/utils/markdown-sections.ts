import { nextFenceState, type FenceState } from "./markdown-fences";

/** One heading and the lines under it, up to the next split heading. */
export interface MarkdownSection {
  /** Heading level, 1 to 6. */
  readonly level: number;
  /** Heading text without the `#` markers. */
  readonly heading: string;
  /** Zero-based index of the heading line. */
  readonly startLine: number;
  /** Zero-based index after the last line of the section. */
  readonly endLine: number;
}

/** A Markdown or MDX body split at its top-level headings. */
export interface MarkdownSectionLayout {
  readonly lines: readonly string[];
  /** Zero-based index after the last line before the first section. */
  readonly preambleEnd: number;
  readonly sections: readonly MarkdownSection[];
}

interface OpenJsxTag {
  readonly closing: boolean;
  quote?: string;
  braces: number;
}

interface JsxScanState {
  depth: number;
  openTag?: OpenJsxTag;
  invalid: boolean;
}

const HEADING_PATTERN = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const JSX_TAG_START = /^<(\/?)(?:([A-Za-z][\w.-]*)(?=[\s/>]|$)|(?=>))/;
const INLINE_CODE = /(`+)[^`]*?\1/g;

/**
 * Splits a body at every heading of `maxLevel` or a higher level that is
 * outside a fenced code block and outside an MDX component. Returns null
 * when a fence or a component stays open at the end, because a split of
 * that body cannot be trusted.
 */
export function splitMarkdownSections(
  body: string,
  maxLevel: number,
): MarkdownSectionLayout | null {
  const lines = body.split("\n");
  const headings: Array<Omit<MarkdownSection, "endLine">> = [];
  const jsx: JsxScanState = { depth: 0, invalid: false };
  let fence: FenceState | undefined;

  for (const [index, line] of lines.entries()) {
    const fenceBefore = fence;
    fence = nextFenceState(line, fence);
    if (fenceBefore || fence) continue;

    const atTopLevel = jsx.depth === 0 && !jsx.openTag;
    const heading = atTopLevel ? parseHeading(line) : null;
    if (heading && heading.level <= maxLevel) {
      headings.push({ ...heading, startLine: index });
      continue;
    }
    scanJsxLine(line, jsx);
    if (jsx.invalid) return null;
  }

  if (fence || jsx.depth !== 0 || jsx.openTag) return null;

  const sections = headings.map((heading, index): MarkdownSection => ({
    ...heading,
    endLine: headings[index + 1]?.startLine ?? lines.length,
  }));
  return {
    lines,
    preambleEnd: sections[0]?.startLine ?? lines.length,
    sections,
  };
}

/** The text of one section, heading line included. */
export function markdownSectionText(
  layout: MarkdownSectionLayout,
  section: MarkdownSection,
): string {
  return layout.lines
    .slice(section.startLine, section.endLine)
    .join("\n")
    .trim();
}

/**
 * The index of the section that holds a zero-based line, or null when the
 * line is in the preamble or outside the body.
 */
export function sectionIndexForLine(
  layout: MarkdownSectionLayout,
  line: number,
): number | null {
  const index = layout.sections.findIndex((section) =>
    line >= section.startLine && line < section.endLine
  );
  return index < 0 ? null : index;
}

/**
 * Rebuilds the body with the given sections replaced. Every other line
 * stays byte for byte, and sections stay separated by one blank line.
 */
export function spliceMarkdownSections(
  layout: MarkdownSectionLayout,
  replacements: ReadonlyMap<number, string>,
): string {
  const parts: string[] = [];
  const preamble = layout.lines.slice(0, layout.preambleEnd).join("\n").trimEnd();
  if (preamble) parts.push(preamble);
  for (const [index, section] of layout.sections.entries()) {
    const replacement = replacements.get(index);
    parts.push(
      replacement === undefined
        ? layout.lines.slice(section.startLine, section.endLine).join("\n").trimEnd()
        : replacement.trim(),
    );
  }
  return parts.join("\n\n");
}

function parseHeading(
  line: string,
): Pick<MarkdownSection, "level" | "heading"> | null {
  const match = HEADING_PATTERN.exec(line);
  const marker = match?.[1];
  const heading = match?.[2]?.trim();
  if (!marker || !heading) return null;
  return { level: marker.length, heading };
}

/**
 * Tracks MDX component nesting through one line. Inline code is blanked
 * first, so a tag shown as code does not count. An autolink such as
 * `<https://...>` does not match the tag pattern.
 */
function scanJsxLine(line: string, state: JsxScanState): void {
  const text = line.replace(INLINE_CODE, (match) => " ".repeat(match.length));
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    const tag = state.openTag;
    if (tag) {
      index += scanOpenTagChar(text, index, tag, state);
      continue;
    }
    if (char === "<") {
      const match = JSX_TAG_START.exec(text.slice(index));
      if (match) {
        state.openTag = { closing: match[1] === "/", braces: 0 };
        index += match[0].length;
        continue;
      }
    }
    index += 1;
  }
}

/** Advances through one character of an open tag and returns the step. */
function scanOpenTagChar(
  text: string,
  index: number,
  tag: OpenJsxTag,
  state: JsxScanState,
): number {
  const char = text[index];
  if (tag.quote) {
    if (char === tag.quote) tag.quote = undefined;
    return 1;
  }
  if (char === "\"" || char === "'" || char === "`") {
    tag.quote = char;
    return 1;
  }
  if (char === "{") {
    tag.braces += 1;
    return 1;
  }
  if (char === "}") {
    tag.braces = Math.max(0, tag.braces - 1);
    return 1;
  }
  if (tag.braces > 0) return 1;
  if (char === "/" && text[index + 1] === ">") {
    state.openTag = undefined;
    return 2;
  }
  if (char === ">") {
    state.openTag = undefined;
    state.depth += tag.closing ? -1 : 1;
    if (state.depth < 0) state.invalid = true;
  }
  return 1;
}
