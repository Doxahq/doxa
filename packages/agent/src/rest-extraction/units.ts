import { hashObject } from "../utils/hash";
import type { RouteFile } from "./route-scan";

/** The most characters of numbered source in one extraction call. */
export const MAX_UNIT_CHARS = 40_000;
/** A longer line, such as minified code, is cut; it holds no readable route. */
const MAX_LINE_CHARS = 2_000;

/** A file, or a range of its lines, inside an extraction unit. */
export interface UnitPart {
  path: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  /** The lines as `<line>| <text>`, so the model can cite a line. */
  numberedText: string;
}

/** The source of one extraction call: whole files, or ranges of one large file. */
export interface ExtractionUnit {
  parts: UnitPart[];
  size: number;
}

/**
 * Cuts route files into units of at most 40,000 characters, in path order.
 * Small files share a unit. A larger file splits at its route registration
 * lines, so no registration is cut from its handler; a range with no
 * registration to cut at splits by lines.
 */
export function buildExtractionUnits(files: readonly RouteFile[], maxChars = MAX_UNIT_CHARS): ExtractionUnit[] {
  const units: ExtractionUnit[] = [];
  let current: UnitPart[] = [];
  let currentSize = 0;
  for (const part of files.flatMap((file) => fileParts(file, maxChars))) {
    const size = part.numberedText.length;
    if (current.length > 0 && currentSize + size > maxChars) {
      units.push({ parts: current, size: currentSize });
      current = [];
      currentSize = 0;
    }
    current.push(part);
    currentSize += size;
  }
  if (current.length > 0) units.push({ parts: current, size: currentSize });
  return units;
}

/**
 * Two halves of a unit whose answer did not fit the output limit: its parts
 * in two lists, or its one part in two line ranges. Undefined for a unit of
 * one line, which cannot split.
 */
export function splitUnit(unit: ExtractionUnit): [ExtractionUnit, ExtractionUnit] | undefined {
  if (unit.parts.length > 1) {
    const middle = Math.ceil(unit.parts.length / 2);
    return [unitOf(unit.parts.slice(0, middle)), unitOf(unit.parts.slice(middle))];
  }
  const [part] = unit.parts;
  if (!part || part.endLine <= part.startLine) return undefined;
  const lines = part.numberedText.split("\n");
  const middle = Math.ceil(lines.length / 2);
  return [
    unitOf([{ ...part, endLine: part.startLine + middle - 1, numberedText: lines.slice(0, middle).join("\n") }]),
    unitOf([{ ...part, startLine: part.startLine + middle, numberedText: lines.slice(middle).join("\n") }]),
  ];
}

/** The identity of a unit's source, for logs and tests. */
export function unitHash(unit: ExtractionUnit): string {
  return hashObject(unit.parts.map((part) => [part.path, part.startLine, part.numberedText]));
}

export function unitPaths(unit: ExtractionUnit): string[] {
  return [...new Set(unit.parts.map((part) => part.path))];
}

function unitOf(parts: UnitPart[]): ExtractionUnit {
  return { parts, size: parts.reduce((total, part) => total + part.numberedText.length, 0) };
}

function fileParts(file: RouteFile, maxChars: number): UnitPart[] {
  const lines = file.text
    .split("\n")
    .map((line, index) => `${index + 1}| ${line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line}`);
  const ranges = lineRanges(lines, file.routeLines, maxChars);
  return ranges.map(([start, end]) => ({
    path: file.path,
    startLine: start + 1,
    endLine: end,
    numberedText: lines.slice(start, end).join("\n"),
  }));
}

/**
 * Line ranges `[start, end)` of at most `maxChars` characters. A range ends
 * before a route registration line where it can, and by lines where it cannot.
 */
function lineRanges(lines: readonly string[], routeLines: readonly number[], maxChars: number): [number, number][] {
  const cutPoints = new Set(routeLines.map((line) => line - 1));
  const ranges: [number, number][] = [];
  let start = 0;
  let size = 0;
  let lastCut = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const lineSize = lines[index]!.length + 1;
    if (index > start && size + lineSize > maxChars) {
      const end = lastCut > start ? lastCut : index;
      ranges.push([start, end]);
      start = end;
      size = lines.slice(start, index).reduce((total, line) => total + line.length + 1, 0);
      lastCut = -1;
    }
    if (cutPoints.has(index)) lastCut = index;
    size += lineSize;
  }
  if (start < lines.length) ranges.push([start, lines.length]);
  return ranges;
}
