/**
 * Frontmatter Utilities
 * Clean, modular utilities for parsing, validating, and building MDX frontmatter.
 */

import { z } from "zod/v4";

export const FrontmatterSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  keywords: z.array(z.string()).optional(),
  icon: z.string().min(1).optional(),
  apiMethod: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]).optional(),
  apiPath: z.string().trim().min(1).optional(),
}).strict();

export type FrontmatterData = z.infer<typeof FrontmatterSchema>;

export interface FrontmatterPolicyInput {
  title: string;
  description: string;
  keywords?: string[];
  icon?: string;
  apiMethod?: string;
  apiPath?: string;
}

export interface FrontmatterPolicyOptions {
  fallbackTitle?: string;
  fallbackDescription?: string;
  allowedIcons?: ReadonlySet<string>;
  /** Preserve a deterministic title whose route syntax is part of its identity. */
  preserveTitle?: boolean;
}

export interface FrontmatterPolicyResult {
  title: string;
  description: string;
  keywords?: string[];
  icon?: string;
  apiMethod?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
  apiPath?: string;
}

const MAX_DESCRIPTION_WORDS = 24;
const MAX_KEYWORDS = 8;
const ALLOWED_TEXT_CHARS = /[^a-zA-Z0-9\s.,:;!?'"()&+\-]/g;
const URL_PATTERN = /\b(?:https?:\/\/|www\.)\S+/i;
const MARKDOWN_LINK_PATTERN = /!?\[([^\]]*)\]\([^)]+\)/g;
const FILE_OR_ROUTE_PATTERN =
  /(^|\s)(?:~?\/|\.\.?\/|[A-Za-z]:\\|[A-Za-z0-9_.-]+\/)[^\s,;:!?()[\]{}"'`<>]+/;
const BACKSLASH_PATH_PATTERN =
  /(^|\s)(?:[A-Za-z]:\\|\\\\)[^\s,;:!?()[\]{}"'`<>]+/;
const DOTTED_PATH_PATTERN =
  /(^|\s)[^\s,;:!?()[\]{}"'`<>]+\.(?:mdx?|tsx?|jsx?|json|ya?ml|txt|css|html|sh|env|toml|lock)\b/i;
const URL_REPLACE_PATTERN = /\b(?:https?:\/\/|www\.)\S+/gi;
const FILE_OR_ROUTE_REPLACE_PATTERN =
  /(^|\s)(?:~?\/|\.\.?\/|[A-Za-z]:\\|[A-Za-z0-9_.-]+\/)[^\s,;:!?()[\]{}"'`<>]+/g;
const BACKSLASH_PATH_REPLACE_PATTERN =
  /(^|\s)(?:[A-Za-z]:\\|\\\\)[^\s,;:!?()[\]{}"'`<>]+/g;
const DOTTED_PATH_REPLACE_PATTERN =
  /(^|\s)[^\s,;:!?()[\]{}"'`<>]+\.(?:mdx?|tsx?|jsx?|json|ya?ml|txt|css|html|sh|env|toml|lock)\b/gi;
/** One file name and nothing else, such as `productContext.md`. */
const FILE_NAME_TITLE_PATTERN =
  /^[A-Za-z0-9_][A-Za-z0-9_.-]*\.(?:mdx?|tsx?|jsx?|json|ya?ml|txt|css|html|sh|env|toml|lock)$/i;
const ICON_PATTERN = /^[a-z][a-zA-Z0-9]*$/;
const KEYWORD_PATTERN = /^[a-z0-9][a-z0-9-]{1,39}$/;
const DANGLING_WORDS = new Set(["and", "or", "for", "to", "with", "from", "of", "in", "on"]);

/**
 * Parse frontmatter from markdown content.
 * Returns the first frontmatter block found and the remaining body.
 */
export function parseFrontmatter(content: string): {
  frontmatter: Record<string, unknown> | null;
  body: string;
} {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) {
    return { frontmatter: null, body: content };
  }

  const rawYaml = match[1];
  const frontmatter: Record<string, unknown> = {};

  for (const line of rawYaml.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();

    // Handle array values like: keywords: [a, b, c]
    if (value.startsWith("[") && value.endsWith("]")) {
      const items = value
        .slice(1, -1)
        .split(",")
        .map((item) => sanitizeValue(item.trim()));
      frontmatter[key] = items;
    } else {
      frontmatter[key] = sanitizeValue(value);
    }
  }

  const body = content.slice(match[0].length);
  return { frontmatter, body };
}

export function applyFrontmatterPolicy(
  input: FrontmatterPolicyInput,
  options: FrontmatterPolicyOptions = {},
): FrontmatterPolicyResult {
  const fallbackTitle = sanitizeTitle(options.fallbackTitle ?? "Documentation");
  const title = options.preserveTitle
    ? input.title.trim()
    : sanitizeTitle(input.title) || fallbackTitle || "Documentation";
  const description = sanitizeDescription(
    input.description,
    options.fallbackDescription ?? `Documentation for ${title}.`,
  );
  const keywords = sanitizeKeywords(input.keywords ?? []);
  const icon = sanitizeIcon(input.icon, options.allowedIcons);
  const apiMethod = normalizeApiMethod(input.apiMethod);
  const apiPath = input.apiPath?.trim();

  return {
    title,
    description,
    ...(keywords.length > 0 ? { keywords } : {}),
    ...(icon ? { icon } : {}),
    ...(apiMethod ? { apiMethod } : {}),
    ...(apiPath ? { apiPath } : {}),
  };
}

function normalizeApiMethod(
  value: string | undefined,
): FrontmatterPolicyResult["apiMethod"] {
  switch (value?.trim().toUpperCase()) {
    case "GET": return "GET";
    case "POST": return "POST";
    case "PUT": return "PUT";
    case "PATCH": return "PATCH";
    case "DELETE": return "DELETE";
    case "HEAD": return "HEAD";
    case "OPTIONS": return "OPTIONS";
    default: return undefined;
  }
}

export function sanitizeDisplayText(value: string): string {
  return trimDanglingWords(normalizePlainText(value));
}

/**
 * The file name that a title consists of, or null. A page about one file,
 * such as `productContext.md`, takes the file name as its title. Display
 * text drops file paths, so such a title must skip that cleanup, or it ends
 * up empty.
 */
export function fileNameTitle(value: string): string | null {
  const unquoted = value.trim().replace(/^(["'`])(.*)\1$/, "$2").trim();
  return FILE_NAME_TITLE_PATTERN.test(unquoted) ? unquoted : null;
}

/** Cleans a page title: a file name stays as it is, any other title becomes display text. */
export function sanitizeTitle(value: string): string {
  return fileNameTitle(value) ?? sanitizeDisplayText(value);
}

export function sanitizeDescription(value: string, fallback: string): string {
  const sanitized = trimToWords(trimDanglingWords(normalizePlainText(value)), MAX_DESCRIPTION_WORDS);
  if (sanitized.split(/\s+/).filter(Boolean).length >= 3) return sanitized;
  return trimToWords(sanitizeDisplayText(fallback), MAX_DESCRIPTION_WORDS) || "Documentation for this page.";
}

export function sanitizeKeywords(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const keywords: string[] = [];

  for (const value of values) {
    const normalized = normalizePlainText(value)
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9\s-]/g, " ")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "");

    if (!KEYWORD_PATTERN.test(normalized)) continue;
    if (DANGLING_WORDS.has(normalized)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    keywords.push(normalized);
    if (keywords.length >= MAX_KEYWORDS) break;
  }

  return keywords;
}

export function sanitizeIcon(value: string | undefined, allowedIcons?: ReadonlySet<string>): string | undefined {
  const icon = sanitizeValue(value ?? "").replace(/[^a-zA-Z0-9]/g, "");
  if (!icon || !ICON_PATTERN.test(icon)) return undefined;
  if (allowedIcons && !allowedIcons.has(icon)) return undefined;
  return icon;
}

/**
 * The sidebar label of a page: the short label when it has at most
 * `maxWords` words, else the whole page title. A title is never cut, because
 * a cut title can lose its meaning, for example "AI Memory: Start" for
 * "AI Memory: Start MCP Server".
 */
export function sanitizeNavTitle(
  label: string,
  pageTitle: string,
  maxWords = 3,
): string {
  const shortLabel = sanitizeTitle(label);
  if (shortLabel && countWords(shortLabel) <= maxWords) return shortLabel;
  return sanitizeTitle(pageTitle) || shortLabel || "Overview";
}

function countWords(value: string): number {
  return value.split(/\s+/).filter(Boolean).length;
}

export function hasUnsafeFrontmatterValue(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) return false;
  return (
    URL_PATTERN.test(normalized) ||
    FILE_OR_ROUTE_PATTERN.test(normalized) ||
    BACKSLASH_PATH_PATTERN.test(normalized) ||
    DOTTED_PATH_PATTERN.test(normalized) ||
    /[`<>{}\[\]|\\]/.test(normalized)
  );
}

const LEADING_FRONTMATTER = /^---\s*\n[\s\S]*?\n---\s*\n?/;

/**
 * Remove ALL frontmatter blocks from content.
 * Handles the case where the agent generates one and the system adds another.
 */
export function stripAllFrontmatter(content: string): string {
  return content.slice(leadingFrontmatterLength(content)).trim();
}

/**
 * Length of the frontmatter blocks at the start of the content. A model can
 * emit more than one block, so every leading block counts.
 */
export function leadingFrontmatterLength(content: string): number {
  let length = 0;
  let match = LEADING_FRONTMATTER.exec(content);
  while (match) {
    length += match[0].length;
    match = LEADING_FRONTMATTER.exec(content.slice(length));
  }
  return length;
}

/**
 * Sanitize a value for use in frontmatter.
 * Strips surrounding quotes, markdown formatting, and special characters.
 * Returns plain text only.
 */
export function sanitizeValue(value: string): string {
  let s = value;

  // Strip surrounding quotes (single or double)
  s = s.replace(/^["'](.*)["']$/, "$1");

  // Remove escaped quotes
  s = s.replace(/\\"/g, "");
  s = s.replace(/\\'/g, "");

  // Remove bold markers: **text** or __text__
  s = s.replace(/\*\*(.+?)\*\*/g, "$1");
  s = s.replace(/__(.+?)__/g, "$1");

  // Remove italic markers: *text* or _text_
  s = s.replace(/\*(.+?)\*/g, "$1");
  s = s.replace(/_(.+?)_/g, "$1");

  // Remove inline code: `text`
  s = s.replace(/`(.+?)`/g, "$1");

  // Remove links: [text](url) -> text
  s = s.replace(/\[(.+?)\]\([^)]+\)/g, "$1");

  // Remove heading markers
  s = s.replace(/^#+\s*/gm, "");

  // Remove HTML tags
  s = s.replace(/<[^>]+>/g, "");

  // Normalize whitespace
  s = s.replace(/\s+/g, " ").trim();

  return s;
}

/**
 * Build a properly formatted frontmatter string from validated data.
 * Values are JSON-quoted so YAML metacharacters in titles/keywords (`:`,
 * `/`, brackets, quotes) cannot break gray-matter parsing.
 */
export function buildFrontmatter(
  data: FrontmatterPolicyInput,
  options: FrontmatterPolicyOptions = {},
): string {
  const clean = applyFrontmatterPolicy(data, options);
  const lines = [
    "---",
    // A file name keeps its underscores, which the Markdown cleanup reads as emphasis.
    `title: ${fileNameTitle(clean.title) ? JSON.stringify(clean.title) : toYamlString(clean.title)}`,
    `description: ${toYamlString(clean.description)}`,
  ];

  if (clean.keywords && clean.keywords.length > 0) {
    lines.push(`keywords: [${clean.keywords.map(toYamlString).join(", ")}]`);
  }

  if (clean.icon) {
    lines.push(`icon: ${toYamlString(clean.icon)}`);
  }

  if (clean.apiMethod) {
    lines.push(`apiMethod: ${JSON.stringify(clean.apiMethod)}`);
  }

  if (clean.apiPath) {
    lines.push(`apiPath: ${JSON.stringify(clean.apiPath)}`);
  }

  lines.push("---");
  return lines.join("\n");
}

function toYamlString(value: string): string {
  return JSON.stringify(sanitizeValue(value));
}

function normalizePlainText(value: string): string {
  let s = sanitizeValue(value);
  s = s.replace(MARKDOWN_LINK_PATTERN, "$1");
  s = s.replace(URL_REPLACE_PATTERN, " ");
  s = s.replace(FILE_OR_ROUTE_REPLACE_PATTERN, " ");
  s = s.replace(BACKSLASH_PATH_REPLACE_PATTERN, " ");
  s = s.replace(DOTTED_PATH_REPLACE_PATTERN, " ");
  s = s.replace(ALLOWED_TEXT_CHARS, " ");
  s = s.replace(/\s+([.,:;!?])/g, "$1");
  s = s.replace(/[,:;!?'"()&+\-]{2,}/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s.replace(/^[.,:;!?'"()&+\-\s]+|[.,:;!?'"()&+\-\s]+$/g, "");
}

function trimDanglingWords(value: string): string {
  const words = value.split(/\s+/).filter(Boolean);
  while (words.length > 1 && DANGLING_WORDS.has(words[words.length - 1].toLowerCase())) {
    words.pop();
  }
  return words.join(" ");
}

function trimToWords(value: string, maxWords: number): string {
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return value;
  return trimDanglingWords(words.slice(0, maxWords).join(" "));
}

/**
 * Combine validated frontmatter + cleaned body into final MDX content.
 */
export function composePage(frontmatter: string, body: string): string {
  const trimmedBody = body.trim();
  return frontmatter + "\n\n" + trimmedBody + "\n";
}
