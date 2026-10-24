/**
 * Renders areas and files as compact text within a token budget.
 *
 * Selection: the header and every area heading come first (the
 * lowest-ranked areas are dropped only when the headings alone do not fit).
 * Then file lines are offered in this order: the best file of each area, in
 * area order, then all other files by score. A line that does not fit is
 * skipped and smaller ones are still tried. The output never exceeds the
 * budget (it is empty when not even the header fits) and contains no paths
 * outside the project, ids, or timestamps.
 */

import { charsForTokens } from "./budget";
import { appendToGroup, compareStrings } from "./collections";
import type { RankedRepoMapFile, RepoMapArea, RepoSymbol, RepoSymbolKind } from "./types";

/** Symbols shown per file line before a `+N` suffix. */
export const MAX_SYMBOLS_PER_FILE = 6;

const KIND_ORDER: readonly RepoSymbolKind[] = [
  "route", "class", "function", "type", "const", "method", "module", "macro", "reexport",
];
const KIND_LABEL: Readonly<Record<RepoSymbolKind, string>> = {
  route: "route",
  class: "class",
  function: "fn",
  type: "type",
  const: "const",
  method: "method",
  module: "mod",
  macro: "macro",
  reexport: "re-export",
};

export interface RenderRepoMapInput {
  areas: readonly RepoMapArea[];
  sourceFileCount: number;
  symbolCount: number;
  tokenBudget: number;
}

export interface RenderedRepoMap {
  text: string;
  renderedFileCount: number;
}

interface CandidateLine {
  areaPath: string;
  file: RankedRepoMapFile;
  text: string;
}

export function renderRepoMap(input: RenderRepoMapInput): RenderedRepoMap {
  const budget = charsForTokens(input.tokenBudget);
  const areas = input.areas
    .map((area) => ({ ...area, files: area.files.filter((file) => !file.hidden) }))
    .filter((area) => area.files.length > 0);
  const header = renderHeader(input, areas.length);

  let shownAreas = areas;
  let omitted = "";
  while (shownAreas.length > 0 && fixedLength(header, shownAreas, omitted) > budget) {
    shownAreas = shownAreas.slice(0, -1);
    omitted = `(+${areas.length - shownAreas.length} more areas not shown)`;
  }

  let used = fixedLength(header, shownAreas, omitted);
  if (used > budget) return { text: "", renderedFileCount: 0 };
  const selected = new Map<string, CandidateLine[]>();
  for (const candidate of candidateLines(shownAreas)) {
    const cost = candidate.text.length + 1;
    if (used + cost > budget) continue;
    used += cost;
    appendToGroup(selected, candidate.areaPath, candidate);
  }

  const lines = [header];
  let renderedFileCount = 0;
  for (const area of shownAreas) {
    lines.push(areaHeading(area));
    const areaLines = [...(selected.get(area.path) ?? [])]
      .sort((a, b) => b.file.score - a.file.score || compareStrings(a.file.path, b.file.path));
    renderedFileCount += areaLines.length;
    lines.push(...areaLines.map((line) => line.text));
  }
  if (omitted) lines.push(omitted);
  return { text: lines.join("\n"), renderedFileCount };
}

function renderHeader(input: RenderRepoMapInput, areaCount: number): string {
  return [
    "REPOSITORY MAP",
    `Built from code: ${input.sourceFileCount} source files, ${input.symbolCount} symbols, ${areaCount} areas.`,
    "Areas and files are ordered by how often other files use them. File paths are relative to their area.",
    "Each line lists the file's exported symbols by kind (fn, class, type, const, route, re-export). Unlisted files exist; search when the map has a gap.",
  ].join("\n");
}

function areaHeading(area: RepoMapArea): string {
  const name = area.packageName ? ` (${area.packageName})` : "";
  const count = area.files.length === 1 ? "1 file" : `${area.files.length} files`;
  return `## ${area.path === "." ? "(root)" : area.path}${name}: ${count}`;
}

function fixedLength(header: string, areas: readonly RepoMapArea[], omitted: string): number {
  const parts = [header, ...areas.map(areaHeading), ...(omitted ? [omitted] : [])];
  return parts.join("\n").length;
}

function candidateLines(areas: readonly RepoMapArea[]): CandidateLine[] {
  const leaders = areas.flatMap((area) => area.files.slice(0, 1).map((file) => ({ area, file })));
  const rest = areas
    .flatMap((area) => area.files.slice(1).map((file) => ({ area, file })))
    .sort((a, b) => b.file.score - a.file.score || compareStrings(a.file.path, b.file.path));
  return [...leaders, ...rest].map(({ area, file }) => ({
    areaPath: area.path,
    file,
    text: fileLine(area.path, file),
  }));
}

function fileLine(areaPath: string, file: RankedRepoMapFile): string {
  const relativePath = areaPath === "." ? file.path : file.path.slice(areaPath.length + 1);
  const symbols = displayedSymbols(file.symbols);
  if (symbols.length === 0) return `- ${relativePath}`;
  const shown = symbols.slice(0, MAX_SYMBOLS_PER_FILE);
  const groups = KIND_ORDER
    .map((kind) => ({ kind, names: shown.filter((symbol) => symbol.kind === kind).map((symbol) => symbol.name) }))
    .filter((group) => group.names.length > 0)
    .map((group) => `${KIND_LABEL[group.kind]} ${group.names.join(", ")}`);
  const more = symbols.length > shown.length ? ` +${symbols.length - shown.length}` : "";
  return `- ${relativePath}: ${groups.join("; ")}${more}`;
}

/** Exported symbols when the file has any, else its top-level declarations. */
function displayedSymbols(symbols: readonly RepoSymbol[]): RepoSymbol[] {
  const exported = symbols.filter((symbol) => symbol.exported);
  const pool = exported.length > 0 ? exported : symbols.filter((symbol) => symbol.kind !== "method");
  return [...pool].sort((a, b) =>
    KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.line - b.line || compareStrings(a.name, b.name),
  );
}
