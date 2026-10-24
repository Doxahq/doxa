import type { ShikiTransformer } from "shiki/core";

import { resolveFenceLanguage } from "./fence-languages";

interface CodeBlockMeta {
  highlightedLineRanges: readonly LineRange[];
  lineNumberStart: number | null;
}

interface LineRange {
  start: number;
  end: number;
}

const highlightedLinesPattern = /\{([\d,\s-]+)\}/;
const lineNumbersPattern = /(?:^|\s)showLineNumbers(?:=(\d+))?(?=\s|$)/i;

const docsCodeBlockTransformer: ShikiTransformer = {
  name: "doxa-code-block-metadata",
  pre(node) {
    const meta = readCodeBlockMeta(this.options.meta?.__raw);
    const language = readLanguage(this.options.lang);

    node.properties.raw = this.source;
    if (language) node.properties["data-language"] = language;
    if (meta.highlightedLineRanges.length > 0) {
      this.addClassToHast(node, "highlight-comp");
    }
  },
  line(node, lineNumber) {
    const meta = readCodeBlockMeta(this.options.meta?.__raw);
    this.addClassToHast(node, "code-line");

    if (meta.lineNumberStart !== null) {
      this.addClassToHast(node, "line-number");
      node.properties.line = meta.lineNumberStart + lineNumber - 1;
    }

    if (isHighlightedLine(meta.highlightedLineRanges, lineNumber)) {
      this.addClassToHast(node, "highlight-line");
    }
  },
};

export function getDocsCodeBlockTransformers(): ShikiTransformer[] {
  return [docsCodeBlockTransformer];
}

function readCodeBlockMeta(rawMeta: string | undefined): CodeBlockMeta {
  const meta = rawMeta?.trim() ?? "";
  const lineNumbersMatch = meta.match(lineNumbersPattern);

  return {
    highlightedLineRanges: parseHighlightedLineRanges(meta),
    lineNumberStart: lineNumbersMatch
      ? (parsePositiveInteger(lineNumbersMatch[1]) ?? 1)
      : null,
  };
}

function parseHighlightedLineRanges(meta: string): readonly LineRange[] {
  const rangeList = meta.match(highlightedLinesPattern)?.[1];
  if (!rangeList) return [];

  return rangeList
    .split(",")
    .map(parseLineRange)
    .filter((range): range is LineRange => range !== null);
}

function parseLineRange(entry: string): LineRange | null {
  const [rawStart, rawEnd] = entry.trim().split("-", 2);
  const start = parsePositiveInteger(rawStart);
  const end = parsePositiveInteger(rawEnd) ?? start;
  return start !== null && end !== null && end >= start ? { start, end } : null;
}

function isHighlightedLine(
  ranges: readonly LineRange[],
  lineNumber: number,
): boolean {
  return ranges.some(
    ({ start, end }) => lineNumber >= start && lineNumber <= end,
  );
}

function parsePositiveInteger(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return parsed > 0 ? parsed : null;
}

function readLanguage(language: unknown): string | null {
  if (typeof language !== "string") return null;
  const trimmed = language.trim();
  if (!trimmed) return null;
  return resolveFenceLanguage(trimmed) ?? trimmed.toLowerCase();
}
