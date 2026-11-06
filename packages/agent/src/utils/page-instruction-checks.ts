import type { DoxabotCodeLanguage, DoxabotInstructions, DoxabotPageType, DoxabotTerminologyEntry } from "@doxahq/contracts/doxabot-instructions";

import { turnedOffPageTypes } from "../doxa-agent/project-instructions/stage-guidance";
import { excludedPathMatcher } from "../doxa-agent/reference-instructions";
import { parseFrontmatter } from "./frontmatter";
import type { ContentQualityIssue } from "./page-validator";
import { headingNamesPageType } from "./planned-page-types";

/** What a finished page must respect. Code reads it, so no model can miss it. */
export interface PageInstructionRules {
  terminology: readonly DoxabotTerminologyEntry[];
  codeLanguages: readonly DoxabotCodeLanguage[];
  doNotDocument: readonly string[];
  turnedOffPageTypes: readonly DoxabotPageType[];
}

export function pageInstructionRules(instructions: DoxabotInstructions): PageInstructionRules {
  return {
    terminology: instructions.terminology,
    codeLanguages: instructions.codeLanguages,
    doNotDocument: instructions.doNotDocument,
    turnedOffPageTypes: turnedOffPageTypes(instructions),
  };
}

/** The issue codes of these checks, so callers can tell them from other issues. */
export const PAGE_INSTRUCTION_CHECKS = [
  "instructionTerminology",
  "instructionCodeLanguage",
  "instructionExcludedPath",
  "instructionPageType",
] as const;

export type PageInstructionCheck = (typeof PAGE_INSTRUCTION_CHECKS)[number];

export function isPageInstructionCheck(check: string): boolean {
  return PAGE_INSTRUCTION_CHECKS.some((code) => code === check);
}

export interface PageInstructionContext {
  /** The frontmatter description, which a reader sees in search and link previews. */
  description?: string;
}

/**
 * One break of the owner's instructions. The subject (the term, path,
 * heading or code group) identifies it across two versions of a page.
 */
export interface PageInstructionBreak {
  check: PageInstructionCheck;
  subject: string;
}

const MAX_REPORTED = 5;

/** The one subject of every code-language break, so that those breaks compare by count. */
const CODE_LANGUAGE_BREAK_SUBJECT = "tabs-group-order";

/**
 * Longer lines are not read by these checks. Every pattern is linear, so this
 * only bounds the work on a pathological line, such as minified or encoded text.
 */
export const MAX_CHECKED_LINE_LENGTH = 8_000;

const FENCE_LANGUAGES: Readonly<Record<string, DoxabotCodeLanguage>> = {
  ts: "typescript",
  tsx: "typescript",
  typescript: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  javascript: "javascript",
  py: "python",
  python: "python",
  go: "go",
  golang: "go",
  rb: "ruby",
  ruby: "ruby",
  java: "java",
  php: "php",
  rs: "rust",
  rust: "rust",
  cs: "csharp",
  csharp: "csharp",
  curl: "curl",
};
const SHELL_LANGUAGES = new Set(["bash", "sh", "shell", "zsh", "console"]);

/** Attributes whose values a reader never reads as text. */
const HIDDEN_ATTRIBUTES = ["href", "src", "to", "id", "icon", "value", "defaultValue", "className", "key", "lang", "language"];
const HIDDEN_ATTRIBUTE_PATTERN = new RegExp(
  `\\b(?:${HIDDEN_ATTRIBUTES.join("|")})=(?:"[^"]*"|'[^']*'|\\{[^{}]*\\})`,
  "g",
);
const HTTP_METHOD_BEFORE = /\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\/?$/;
/** Enough text before a mention to see an HTTP method and its space. */
const HTTP_METHOD_LOOKBACK = 12;

interface PageLine {
  /** Zero-based, as `ContentQualityIssue.location` counts lines. */
  index: number;
  text: string;
  /** The text without comments, which a reader never sees. */
  visible: string;
}

interface CodeFence {
  language: string;
  lines: string[];
  tabsGroup: number | null;
}

interface PageLayout {
  prose: PageLine[];
  fences: CodeFence[];
}

interface OpenFence {
  fence: CodeFence;
  marker: string;
}

/** Reads a page line by line: prose, code fences, comments and `<Tabs>` groups. */
class PageLayoutReader {
  readonly layout: PageLayout = { prose: [], fences: [] };
  private openFence: OpenFence | null = null;
  private inComment = false;
  private readonly tabsStack: number[] = [];
  private tabsGroupCount = 0;

  read(text: string, index: number): void {
    if (this.openFence) {
      this.readCodeLine(this.openFence, text);
      return;
    }
    const opener = text.match(/^\s*(`{3,}|~{3,})\s*([^\s`{]*)/);
    if (opener && !this.inComment) {
      const fence: CodeFence = { language: (opener[2] ?? "").toLowerCase(), lines: [], tabsGroup: this.tabsStack.at(-1) ?? null };
      this.openFence = { fence, marker: opener[1] ?? "```" };
      this.layout.fences.push(fence);
      return;
    }
    const visible = this.withoutComments(text);
    this.trackTabs(visible);
    this.layout.prose.push({ index, text, visible: isCheckedLength(visible) ? visible : "" });
  }

  /** A fence closes only on a fence of the same character, at least as long as the opener. */
  private readCodeLine(open: OpenFence, text: string): void {
    const closer = text.match(/^\s*(`{3,}|~{3,})\s*$/)?.[1];
    if (closer && closer[0] === open.marker[0] && closer.length >= open.marker.length) {
      this.openFence = null;
      return;
    }
    if (isCheckedLength(text)) open.fence.lines.push(text);
  }

  private trackTabs(text: string): void {
    for (const tag of text.matchAll(/<Tabs\b|<\/Tabs>/g)) {
      if (tag[0] === "</Tabs>") this.tabsStack.pop();
      else this.tabsStack.push(this.tabsGroupCount++);
    }
  }

  /** Removes `{/* … *\/}` and `<!-- … -->`, which can span lines. */
  private withoutComments(text: string): string {
    let rest = text;
    let visible = "";
    while (rest) {
      if (this.inComment) {
        const end = rest.search(/\*\/\s*\}|-->/);
        if (end < 0) return visible;
        const close = rest.slice(end).match(/^(?:\*\/\s*\}|-->)/)?.[0] ?? "";
        rest = rest.slice(end + close.length);
        this.inComment = false;
        continue;
      }
      const start = rest.search(/\{\s*\/\*|<!--/);
      if (start < 0) return visible + rest;
      visible += `${rest.slice(0, start)} `;
      rest = rest.slice(start).replace(/^(?:\{\s*\/\*|<!--)/, "");
      this.inComment = true;
    }
    return visible;
  }
}

function isCheckedLength(line: string): boolean {
  return line.length <= MAX_CHECKED_LINE_LENGTH;
}

function readPageLayout(body: string): PageLayout {
  const reader = new PageLayoutReader();
  body.split("\n").forEach((text, index) => reader.read(text, index));
  return reader.layout;
}

/**
 * The words that a reader sees on a line: no code, link target, URL, hidden
 * attribute, or module line. Each pattern starts a match only where the
 * previous one could not, so the work stays linear in the line length.
 */
function visibleText(line: string): string {
  if (/^\s*(?:import|export)\s/.test(line)) return "";
  return line
    .replace(/`[^`]*`/g, " ")
    .replace(/\]\([^()\n]*\)/g, "]")
    .replace(/(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/\S+/gi, " ")
    .replace(HIDDEN_ATTRIBUTE_PATTERN, " ");
}

/** A term and its plural: "repo" also finds "repos", "repository" also finds "repositories". */
function termPattern(term: string, flags: string): RegExp {
  const words = term.trim().split(/\s+/).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const last = words.pop() ?? "";
  const pluralLast = /[^aeiou]y$/i.test(last)
    ? `${last.slice(0, -1)}(?:y|ies)`
    : `${last}(?:e?s)?`;
  const source = [...words, pluralLast].join("\\s+");
  return new RegExp(`(?<![\\w/.@])${source}(?![\\w/@]|\\.\\w)`, flags);
}

/** Consecutive prose lines with text: a term can wrap from one line to the next. */
function paragraphsOf(prose: readonly PageLine[]): PageLine[][] {
  const paragraphs: PageLine[][] = [];
  let current: PageLine[] = [];
  let previousIndex = -2;
  for (const line of prose) {
    const continues = line.index === previousIndex + 1 && line.visible.trim() !== "";
    if (!continues && current.length > 0) {
      paragraphs.push(current);
      current = [];
    }
    if (line.visible.trim() !== "") current.push(line);
    previousIndex = line.index;
  }
  if (current.length > 0) paragraphs.push(current);
  return paragraphs;
}

/** Blanks a match but keeps its line breaks, so offsets still point at the right line. */
function blank(match: string): string {
  return match.replace(/[^\n]/g, " ");
}

interface TermBreak {
  avoid: string;
  use: string;
  line?: PageLine;
}

/**
 * A pair that differs only in case ("GitHub", not "Github") is matched with
 * its case. Otherwise the case does not matter.
 */
function termFlags(entry: DoxabotTerminologyEntry, avoid: string): string {
  return entry.use.toLowerCase() === avoid.toLowerCase() ? "g" : "gi";
}

/** Every use of an avoided term, in the prose and the description. */
function avoidedTermBreaks(
  paragraphs: readonly PageLine[][],
  description: string | undefined,
  entry: DoxabotTerminologyEntry,
  avoid: string,
): TermBreak[] {
  const flags = termFlags(entry, avoid);
  const usedTerm = termPattern(entry.use, flags);
  const avoided = termPattern(avoid, flags);
  const breaks: TermBreak[] = [];
  for (const paragraph of paragraphs) {
    const text = paragraph.map((line) => visibleText(line.visible)).join("\n").replace(usedTerm, blank);
    for (const match of text.matchAll(avoided)) {
      const lineOffset = text.slice(0, match.index).split("\n").length - 1;
      breaks.push({ avoid, use: entry.use, line: paragraph[lineOffset] ?? paragraph[0] });
    }
  }
  if (description && isCheckedLength(description)) {
    const uses = description.replace(usedTerm, blank).matchAll(avoided);
    breaks.push(...Array.from(uses, (): TermBreak => ({ avoid, use: entry.use })));
  }
  return breaks;
}

function terminologyBreaks(
  layout: PageLayout,
  rules: PageInstructionRules,
  context: PageInstructionContext,
): TermBreak[] {
  const paragraphs = paragraphsOf(layout.prose);
  return rules.terminology.flatMap((entry) =>
    entry.avoid.flatMap((avoid) => avoidedTermBreaks(paragraphs, context.description, entry, avoid))
  );
}

function checkTerminology(found: readonly TermBreak[]): ContentQualityIssue[] {
  const pairs = uniqueBy(found, (item) => `${item.use}\u0000${item.avoid}`);
  if (pairs.length === 0) return [];
  const named = pairs
    .slice(0, MAX_REPORTED)
    .map(({ avoid, use }) => `${JSON.stringify(avoid)} (say ${JSON.stringify(use)})`)
    .join(", ");
  const located = found.find((item) => item.line !== undefined)?.line;
  return [{
    check: "instructionTerminology",
    severity: "soft",
    message: `The page uses terms that the project owner avoids: ${named}.`,
    fixInstruction:
      "Replace each term with the term that the owner asked for, in headings, component text and the description too. " +
      "Keep the word only inside a product name, a code identifier, or quoted text.",
    ...(located ? { location: { line: located.index, snippet: located.text } } : {}),
  }];
}

function isShellComment(line: string): boolean {
  return /^\s*#/.test(line);
}

function fenceLanguage(fence: CodeFence): DoxabotCodeLanguage | undefined {
  if (SHELL_LANGUAGES.has(fence.language)) {
    const runsCurl = fence.lines.some((line) => !isShellComment(line) && /^\s*(?:\$\s*)?curl\b/.test(line));
    return runsCurl ? "curl" : undefined;
  }
  return FENCE_LANGUAGES[fence.language];
}

interface CodeLanguageBreak {
  /** The languages the group shows, in its order. */
  shown: DoxabotCodeLanguage[];
  expectedFirst: DoxabotCodeLanguage;
}

/** Only `<Tabs>` compare languages: a lone example in another language can be all that exists. */
function codeLanguageBreaks(layout: PageLayout, rules: PageInstructionRules): CodeLanguageBreak[] {
  if (rules.codeLanguages.length === 0) return [];

  const groups = new Map<number, DoxabotCodeLanguage[]>();
  for (const fence of layout.fences) {
    const language = fenceLanguage(fence);
    if (language === undefined || fence.tabsGroup === null) continue;
    const group = groups.get(fence.tabsGroup) ?? [];
    if (!group.includes(language)) group.push(language);
    groups.set(fence.tabsGroup, group);
  }

  return Array.from(groups.values()).flatMap((shown) => {
    const expectedFirst = rules.codeLanguages.find((language) => shown.includes(language));
    if (expectedFirst === undefined) return [];
    const others = shown.filter((language) => !rules.codeLanguages.includes(language));
    return shown[0] === expectedFirst && others.length === 0 ? [] : [{ shown, expectedFirst }];
  });
}

function checkCodeLanguages(found: readonly CodeLanguageBreak[], rules: PageInstructionRules): ContentQualityIssue[] {
  const [first] = found;
  if (!first) return [];
  return [{
    check: "instructionCodeLanguage",
    severity: "soft",
    message: `A <Tabs> group does not follow the owner's code languages: ${rules.codeLanguages.join(", ")}.`,
    fixInstruction:
      `Put ${first.expectedFirst} first in each <Tabs> group, keep the owner's order, ` +
      "and remove a language that the owner did not name when the group already shows one that they named.",
  }];
}

type PathMatcher = (path: string) => boolean;

interface PathMention {
  path: string;
  line: PageLine | null;
}

/** `./a/b`, `../a/b` and `a/b/` all name `a/b` from the repository root. */
function repositoryPath(mention: string): string {
  return mention.replace(/^(?:\.{1,2}\/)+/, "").replace(/\/+$/, "");
}

/** A folder mention is excluded when the files in it are. */
function isExcludedMention(isExcluded: PathMatcher, mention: string): boolean {
  const path = repositoryPath(mention);
  if (!path) return false;
  return mention.endsWith("/") ? isExcluded(path) || isExcluded(`${path}/index`) : isExcluded(path);
}

/**
 * A longer token is not a path that a reader follows, and the matcher tests
 * every folder of a path, so a long token would cost work for each folder.
 */
const MAX_PATH_MENTION_LENGTH = 512;

/** A file name with an extension, or a path with a folder: `INTERNAL.md`, `internal/`, `src/a.ts`. */
function looksLikePath(text: string): boolean {
  if (text.length > MAX_PATH_MENTION_LENGTH) return false;
  return /^(?:\.{1,2}\/)*[\w@-][\w@.*-]*(?:\/[\w@.*-]+)*\/?$/.test(text)
    && (text.includes("/") || /\.[A-Za-z][\w-]*$/.test(text));
}

function followsHttpMethod(text: string, index: number): boolean {
  return HTTP_METHOD_BEFORE.test(text.slice(Math.max(0, index - HTTP_METHOD_LOOKBACK), index));
}

/**
 * Paths in prose, outside code and links. A route after an HTTP method is not
 * a path. A mention starts only after a character that cannot be part of a
 * path, so no part of a path is scanned twice.
 */
function prosePathMentions(line: PageLine): string[] {
  const text = visibleText(line.visible);
  const mentions: string[] = [];
  for (const match of text.matchAll(/(?<![\w/:.@*-])((?:\.{1,2}\/)*[\w@-][\w@.-]*(?:\/[\w@.*-]*)*)/g)) {
    const token = (match[1] ?? "").replace(/[.]+$/, "");
    if (!looksLikePath(token)) continue;
    if (followsHttpMethod(text, match.index)) continue;
    mentions.push(token);
  }
  return mentions;
}

/** Paths in inline code: `` `internal/` ``, `` `INTERNAL.md` ``. A route such as `` `GET /users` `` is not one. */
function inlineCodePathMentions(line: PageLine): string[] {
  return Array.from(line.visible.matchAll(/`([^`]+)`/g), (match) => (match[1] ?? "").trim())
    .filter((code) => !code.startsWith("/") && looksLikePath(code));
}

/** The modules that a JavaScript-style example imports or requires, by their quoted path. */
function quotedModules(lines: readonly string[]): string[] {
  return lines.flatMap((line) =>
    Array.from(
      line.matchAll(/(?:\bfrom\s+|\bimport\s+|\brequire\(\s*|\bimport\(\s*)["']([^"']+)["']/g),
      (match) => match[1] ?? "",
    )
  ).filter((module) => module.includes("/"));
}

/**
 * A module path longer than this is not one that a reader follows. An
 * import item longer than a path, an alias and spaces is skipped before any
 * pattern runs, so one item costs work bounded by this length.
 */
const MAX_MODULE_PATH_LENGTH = 160;
const MAX_IMPORT_ITEM_LENGTH = MAX_MODULE_PATH_LENGTH * 2;
/**
 * A Rust group import repeats its base for each member, so the paths of one
 * line can be much longer than the line. Members are read until their paths
 * reach this length; a group that long is not an example a reader follows.
 */
const MAX_EXPANDED_PATH_CHARS_PER_LINE = 8_000;

/**
 * `internal.secret` and `crate::internal::secret` as repository paths: the
 * file the module can be, and the folder it can be (`internal/`), so that a
 * folder glob such as `internal/**` also catches `import internal`.
 */
function modulePathCandidates(modulePath: string, separator: "." | "::", extension: string): string[] {
  if (modulePath.length > MAX_MODULE_PATH_LENGTH) return [];
  const segments = modulePath.split(separator).filter((segment) => segment !== "");
  const withoutAnchor = separator === "::" && ["crate", "self", "super"].includes(segments[0] ?? "")
    ? segments.slice(1)
    : segments;
  if (withoutAnchor.length === 0) return [];
  const path = withoutAnchor.join("/");
  return [path, `${path}${extension}`, `${path}/`];
}

const PYTHON_MODULE = /^[\w.]+$/;
const RUST_MODULE = /^[\w:]+$/;
const ALIAS = /^\w+$/;

/**
 * The module of one import item: `internal.secret as s` gives
 * `internal.secret`. Split on spaces instead of a pattern over the item, so
 * a long run of spaces costs one pass.
 */
function importedModule(item: string, modulePattern: RegExp): string | null {
  if (item.length > MAX_IMPORT_ITEM_LENGTH) return null;
  const words = item.trim().split(/\s+/);
  const [module = "", keyword, alias] = words;
  const isPlain = words.length === 1;
  const isAliased = words.length === 3 && keyword === "as" && ALIAS.test(alias ?? "");
  return (isPlain || isAliased) && modulePattern.test(module) ? module : null;
}

/**
 * `from internal.secret import x`, `from .internal import x`,
 * `import internal.secret as s, other`.
 */
function pythonModules(lines: readonly string[]): string[] {
  return lines.flatMap((line) => {
    const code = line.replace(/#.*$/, "");
    // The module starts with a word character, so the leading dots of a
    // relative import and the module never compete for the same characters.
    const fromImport = code.match(/^\s*from\s+\.*(\w[\w.]*)\s+import\b/);
    if (fromImport) return modulePathCandidates(fromImport[1] ?? "", ".", ".py");
    const plainImport = code.match(/^\s*import\s+(.+)$/);
    if (!plainImport) return [];
    return (plainImport[1] ?? "").split(",")
      .map((item) => importedModule(item, PYTHON_MODULE))
      .filter((module): module is string => module !== null)
      .flatMap((module) => modulePathCandidates(module, ".", ".py"));
  });
}

/** `use internal::secret;`, `pub use crate::internal::secret::Thing;`, `use internal::{a, b::c};`. */
function rustModules(lines: readonly string[]): string[] {
  return lines.flatMap((line) => {
    const use = line.match(/^\s*(?:pub(?:\([\w\s:]+\))?\s+)?use\s+([\w:]*\w)(?:::\{([^{}]*)\})?/);
    if (!use) return [];
    const base = use[1] ?? "";
    const members = (use[2] ?? "").split(",")
      .map((member) => importedModule(member, RUST_MODULE))
      .filter((member): member is string => member !== null && member !== "self");
    return withinLength([base, ...members.map((member) => `${base}::${member}`)], MAX_EXPANDED_PATH_CHARS_PER_LINE)
      .flatMap((module) => modulePathCandidates(module, "::", ".rs"));
  });
}

/** The leading values whose lengths add up to at most `maxChars`. */
function withinLength(values: readonly string[], maxChars: number): string[] {
  const kept: string[] = [];
  let total = 0;
  for (const value of values) {
    total += value.length;
    if (total > maxChars) break;
    kept.push(value);
  }
  return kept;
}

/**
 * The paths in one shell token: `KEY=internal/x` gives `internal/x`, and a
 * mount such as `internal/data:/data` gives its source. A URL or a flag is not a path.
 */
function shellTokenPaths(token: string): string[] {
  const value = token.replace(/^["']|["';]$/g, "").replace(/^[^=]*=/, "");
  if (value === "" || value.includes("://") || value.startsWith("/") || value.startsWith("-")) return [];
  const mountSource = value.match(/^([^:]+):\//)?.[1];
  return [mountSource ?? value].filter(looksLikePath);
}

/** Path arguments of shell commands: `cd internal/tools`, `python internal/x.py`, `docker -v internal/data:/data`. */
function shellPaths(lines: readonly string[]): string[] {
  return lines
    .filter((line) => !isShellComment(line))
    .flatMap((line) => line.replace(/^\s*\$\s*/, "").split(/\s+/))
    .flatMap(shellTokenPaths);
}

function codePathMentions(fence: CodeFence): string[] {
  const language = fenceLanguage(fence) ?? fence.language;
  if (language === "python") return [...pythonModules(fence.lines), ...quotedModules(fence.lines)];
  if (language === "rust") return rustModules(fence.lines);
  if (SHELL_LANGUAGES.has(fence.language) || language === "curl") return shellPaths(fence.lines);
  return quotedModules(fence.lines);
}

function pathMentions(layout: PageLayout): PathMention[] {
  return [
    ...layout.prose.flatMap((line) =>
      [...prosePathMentions(line), ...inlineCodePathMentions(line)].map((path) => ({ path, line }))
    ),
    ...layout.fences.flatMap((fence) => codePathMentions(fence).map((path) => ({ path, line: null }))),
  ];
}

/** Every mention of an excluded path, keyed by the path from the repository root. */
function excludedPathBreaks(layout: PageLayout, rules: PageInstructionRules): PathMention[] {
  const isExcluded = excludedPathMatcher(rules.doNotDocument);
  if (!isExcluded) return [];
  return pathMentions(layout)
    .filter((mention) => isExcludedMention(isExcluded, mention.path))
    .map((mention) => ({ ...mention, path: repositoryPath(mention.path) }));
}

function checkExcludedPaths(found: readonly PathMention[]): ContentQualityIssue[] {
  const paths = uniqueBy(found, (mention) => mention.path).map((mention) => mention.path);
  if (paths.length === 0) return [];
  const located = found.find((mention) => mention.line !== null)?.line;
  return [{
    check: "instructionExcludedPath",
    severity: "soft",
    message: `The page names paths that the project owner excluded: ${paths.slice(0, MAX_REPORTED).join(", ")}.`,
    fixInstruction: "Remove these paths and what the page says only about them. Describe what the reader sees instead.",
    ...(located ? { location: { line: located.index, snippet: located.text } } : {}),
  }];
}

interface PageTypeBreak {
  heading: string;
  line: PageLine;
}

/**
 * The text of a `##` to `######` heading, trimmed. A trim instead of a lazy
 * pattern with trailing spaces, which rescans the spaces at every position.
 */
function headingText(visible: string): string | null {
  const marker = visible.match(/^#{2,6}\s/);
  if (!marker) return null;
  const text = visible.slice(marker[0].length).trim();
  return text === "" ? null : text;
}

function pageTypeBreaks(layout: PageLayout, rules: PageInstructionRules): PageTypeBreak[] {
  return layout.prose.flatMap((line) => {
    const heading = headingText(line.visible);
    if (!heading) return [];
    return rules.turnedOffPageTypes.some((type) => headingNamesPageType(heading, type)) ? [{ heading, line }] : [];
  });
}

function checkPageTypeSections(found: readonly PageTypeBreak[]): ContentQualityIssue[] {
  const [first] = found;
  if (!first) return [];
  return [{
    check: "instructionPageType",
    severity: "soft",
    message: `The section "${first.heading}" belongs to a page type that the project owner turned off.`,
    fixInstruction: "Remove this section. Keep its facts only where they help the reader with the task on this page.",
    location: { line: first.line.index, snippet: first.line.text },
  }];
}

interface PageInstructionFindings {
  terms: TermBreak[];
  codeLanguages: CodeLanguageBreak[];
  paths: PathMention[];
  pageTypes: PageTypeBreak[];
}

function findPageInstructionBreaks(
  body: string,
  rules: PageInstructionRules,
  context: PageInstructionContext,
): PageInstructionFindings {
  const layout = readPageLayout(body);
  return {
    terms: terminologyBreaks(layout, rules, context),
    codeLanguages: codeLanguageBreaks(layout, rules),
    paths: excludedPathBreaks(layout, rules),
    pageTypes: pageTypeBreaks(layout, rules),
  };
}

/**
 * Soft issues only, one per check: the writer gets another attempt with the
 * reason, and a page never fails or drops because of a word. A regular
 * expression cannot tell a product name from the term that the owner avoids.
 */
export function checkPageInstructions(
  body: string,
  rules: PageInstructionRules,
  context: PageInstructionContext = {},
): ContentQualityIssue[] {
  const found = findPageInstructionBreaks(body, rules, context);
  return [
    ...checkTerminology(found.terms),
    ...checkCodeLanguages(found.codeLanguages, rules),
    ...checkExcludedPaths(found.paths),
    ...checkPageTypeSections(found.pageTypes),
  ];
}

/** The same checks on a whole page: frontmatter description and body. */
export function checkPageInstructionsOfPage(content: string, rules: PageInstructionRules): ContentQualityIssue[] {
  const { body, context } = pageParts(content);
  return checkPageInstructions(body, rules, context);
}

/** Every break of a whole page, one entry per occurrence, to compare two versions of the page. */
export function listPageInstructionBreaksOfPage(content: string, rules: PageInstructionRules): PageInstructionBreak[] {
  const { body, context } = pageParts(content);
  const found = findPageInstructionBreaks(body, rules, context);
  return [
    ...found.terms.map((item): PageInstructionBreak => ({
      check: "instructionTerminology",
      subject: item.avoid.toLowerCase(),
    })),
    // Code-language breaks compare by count: a splice that fixes the order of
    // a <Tabs> group but changes its languages still has one break, not a new one.
    ...found.codeLanguages.map((): PageInstructionBreak => ({
      check: "instructionCodeLanguage",
      subject: CODE_LANGUAGE_BREAK_SUBJECT,
    })),
    ...found.paths.map((item): PageInstructionBreak => ({ check: "instructionExcludedPath", subject: item.path })),
    ...found.pageTypes.map((item): PageInstructionBreak => ({
      check: "instructionPageType",
      subject: item.heading.toLowerCase(),
    })),
  ];
}

/**
 * The breaks that `after` has beyond `before`, counted per check and subject:
 * one more use of an avoided term is a new break, as is a new path.
 */
export function addedPageInstructionBreaks(
  before: readonly PageInstructionBreak[],
  after: readonly PageInstructionBreak[],
): PageInstructionBreak[] {
  const remaining = new Map<string, number>();
  for (const item of before) remaining.set(breakKey(item), (remaining.get(breakKey(item)) ?? 0) + 1);
  return after.filter((item) => {
    const key = breakKey(item);
    const count = remaining.get(key) ?? 0;
    if (count > 0) {
      remaining.set(key, count - 1);
      return false;
    }
    return true;
  });
}

function breakKey(item: PageInstructionBreak): string {
  return `${item.check}\u0000${item.subject}`;
}

function pageParts(content: string): { body: string; context: PageInstructionContext } {
  const { frontmatter, body } = parseFrontmatter(content);
  const description = typeof frontmatter?.description === "string" ? frontmatter.description : undefined;
  return { body, context: description ? { description } : {} };
}

function uniqueBy<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = keyOf(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
