/**
 * Page Validation & Content Guardrails
 *
 * Two layers of checks run on every generated MDX page:
 *
 *  1. {@link validatePage} — frontmatter schema, quoting, duplicate-block detection.
 *     These are structural checks; failures point at malformed YAML or missing
 *     required fields.
 *
 *  2. {@link checkContentQuality} — body-level heuristics that catch model
 *     failure modes (skeleton pages, cutoff content, unbalanced fences,
 *     misused `<Step>` blocks, trailing or empty headings). Each detect* function returns an enriched
 *     {@link ContentQualityIssue} carrying:
 *       - `severity`: hard issues require regeneration; soft issues can be
 *         auto-fixed via {@link applyAutoFixes} when retries are exhausted.
 *       - `fixInstruction`: a model-facing description of what to change on
 *         the next attempt — used by {@link buildRetryHint}.
 *       - `fixExample`: optional inline bad/good snippet for high-leverage
 *         gotchas (outer fence wrapping, preambles).
 *       - `autoFix`: best-effort transform applied during graceful
 *         degradation — only invoked for soft issues.
 *
 * Commentary stripping lives in {@link ../commentary-patterns}; we re-export
 * {@link stripAgentCommentary} here for backwards-compatible imports.
 */

import {
  FrontmatterSchema,
  fileNameTitle,
  hasUnsafeFrontmatterValue,
  parseFrontmatter,
  stripAllFrontmatter,
  buildFrontmatter,
  composePage,
} from "./frontmatter";
import { hasUnbalancedPunctuation } from "./title-validation";
import { stripAgentCommentary } from "./commentary-patterns";
import { compileMdx, type MdxCompileError } from "./mdx-compile";
import type { AgentSpanCallback } from "../core/types";
import { RUNTIME_MDX_COMPONENT_NAMES } from "@doxahq/mdx-runtime";
import {
  extractMdxComponents,
  loadAllowedComponents,
} from "./component-allowlist";
import { findEmbeddedFrontmatterArtifact } from "./frontmatter-artifacts";
import {
  findRestEndpointDuplicateSection,
  removeRestEndpointDuplicateSection,
} from "./rest-endpoint-sections";
import {
  findStepProblems,
  normalizeStepBlocks,
  type StepProblemKind,
} from "./step-blocks";
import { REDACTED, SecretRedactor, findSecret } from "../reference-specs/secrets";
import { findUnsafeMarkup } from "./generated-markup";

export { stripAgentCommentary } from "./commentary-patterns";

// ─── Frontmatter Validation ────────────────────────────────────────────

export interface ValidationError {
  field: string;
  message: string;
  severity: "error" | "warning";
  line?: number;
  snippet?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  cleaned: string;
}

export interface PageValidationOptions {
  /** Allow deterministic REST method-and-path titles without normalizing route syntax. */
  preserveTitle?: boolean;
}

/**
 * Validate and clean a generated MDX page.
 * Checks for proper frontmatter, validates schema, removes commentary.
 */
export function validatePage(
  content: string,
  options: PageValidationOptions = {},
): ValidationResult {
  const errors: ValidationError[] = [];

  let cleaned = stripAgentCommentary(content);

  const { frontmatter, body } = parseFrontmatter(cleaned);
  if (!frontmatter) {
    errors.push({
      field: "frontmatter",
      message: "No frontmatter block found",
      severity: "error",
    });
    return { valid: false, errors, cleaned };
  }

  const schemaResult = FrontmatterSchema.safeParse(frontmatter);
  if (!schemaResult.success) {
    for (const issue of schemaResult.error.issues) {
      errors.push({
        field: `frontmatter.${issue.path.join(".")}`,
        message: issue.message,
        severity: "error",
      });
    }
  }

  for (const [key, value] of Object.entries(frontmatter)) {
    const values = Array.isArray(value) ? value : [value];
    if (values.some((item) => typeof item === "string" && findSecret(item) !== null)) {
      // No snippet: the retry prompt must not repeat the value.
      errors.push({
        field: `frontmatter.${key}`,
        message: "Frontmatter value contains what looks like a real credential.",
        severity: "error",
      });
    }
    if (!["title", "description", "keywords", "icon", "apiMethod", "apiPath"].includes(key)) {
      errors.push({
        field: `frontmatter.${key}`,
        message: "Unsupported frontmatter field.",
        severity: "error",
      });
    }
    // A title that is one file name, such as `productContext.md`, is safe.
    const isPreservedTitle =
      key === "title" && (options.preserveTitle || (typeof value === "string" && fileNameTitle(value) !== null));
    const isRestMetadata = key === "apiMethod" || key === "apiPath";
    if (
      typeof value === "string" &&
      !isPreservedTitle &&
      !isRestMetadata &&
      hasUnsafeFrontmatterValue(value)
    ) {
      errors.push({
        field: `frontmatter.${key}`,
        message: "Frontmatter value contains a URL, path, code marker, or unsupported character.",
        severity: "error",
      });
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && hasUnsafeFrontmatterValue(item)) {
          errors.push({
            field: `frontmatter.${key}`,
            message: "Frontmatter array contains a URL, path, code marker, or unsupported character.",
            severity: "error",
          });
          break;
        }
      }
    }
  }

  if (
    typeof frontmatter.title === "string" &&
    hasUnbalancedPunctuation(frontmatter.title)
  ) {
    errors.push({
      field: "frontmatter.title",
      message: "Title contains unbalanced punctuation.",
      severity: "error",
    });
  }

  for (const [key, value] of Object.entries(frontmatter)) {
    if (typeof value === "string" && (value.startsWith('"') || value.startsWith("'"))) {
      errors.push({
        field: `frontmatter.${key}`,
        message: `Value contains surrounding quotes: ${value}`,
        severity: "warning",
      });
    }
  }

  const bodyAfterFirst = body.trim();
  const duplicateMatch = /(?:^|\n)(---\s*\n\s*title:\s*[^\n]+[\s\S]*?\n---)/.exec(bodyAfterFirst);
  if (duplicateMatch) {
    const duplicateOffset = duplicateMatch.index + (duplicateMatch[0].startsWith("\n") ? 1 : 0);
    const bodyOffset = cleaned.indexOf(body);
    const line = cleaned.slice(0, Math.max(0, bodyOffset) + duplicateOffset).split("\n").length;
    errors.push({
      field: "body",
      message: "Body contains an additional frontmatter block (duplicate)",
      severity: "error",
      line,
      snippet: duplicateMatch[1].split("\n").slice(0, 4).join("\n"),
    });
    if (/^---\s*\n/.test(bodyAfterFirst)) {
      const cleanBody = stripAllFrontmatter(bodyAfterFirst);
      const metadata = {
        title: String(frontmatter.title || ""),
        description: String(frontmatter.description || ""),
        keywords: Array.isArray(frontmatter.keywords)
          ? frontmatter.keywords.map((k: unknown) => String(k))
          : undefined,
        icon: typeof frontmatter.icon === "string" ? frontmatter.icon : undefined,
      };
      cleaned = composePage(
        buildFrontmatter(metadata, options),
        cleanBody,
      );
    }
  } else {
    const artifact = findEmbeddedFrontmatterArtifact(bodyAfterFirst);
    if (artifact) {
      const bodyOffset = cleaned.indexOf(bodyAfterFirst);
      const bodyStartLine = cleaned.slice(0, Math.max(0, bodyOffset)).split("\n").length;
      errors.push({
        field: "body-frontmatter-artifact",
        message: "Body contains a frontmatter-shaped metadata block",
        severity: "error",
        line: bodyStartLine + artifact.line - 1,
        snippet: artifact.snippet.split("\n").slice(0, 6).join("\n"),
      });
    }
  }

  const valid = errors.filter((e) => e.severity === "error").length === 0;
  return { valid, errors, cleaned };
}

// ─── Content Quality Checks ────────────────────────────────────────────

export type IssueSeverity = "hard" | "soft";

export interface ContentQualityIssue {
  /** Stable identifier — e.g. "skeletonPage", "emptySection". */
  check: string;
  /** Human-readable summary of the problem. */
  message: string;
  /** `hard` issues require regeneration. `soft` issues can be auto-fixed. */
  severity: IssueSeverity;
  /** Where the problem occurred + a small excerpt for retry feedback. */
  location?: { line: number; column?: number; snippet: string };
  /** Model-facing instruction to resolve this specific issue on retry. */
  fixInstruction: string;
  /** Optional bad/good snippet rendered inline in the retry prompt. */
  fixExample?: { bad: string; good: string };
  /** Recovery transform applied during graceful degradation. */
  autoFix?: (body: string) => string;
}

export interface ContentQualityResult {
  /** True when no issues were detected. */
  acceptable: boolean;
  issues: ContentQualityIssue[];
  /** Aggregated retry hint string (kept for callers that don't use buildRetryHint). */
  retryHint: string;
}

/**
 * Heading level for a markdown line (1-6) or `null` when the line is not a
 * heading. Counts the leading `#` characters and requires a trailing space
 * so we don't classify `#tag` or `#!shebang` as a heading.
 */
export function getHeadingLevel(line: string): number | null {
  const match = line.match(/^(#{1,6})\s/);
  return match ? match[1].length : null;
}

// ─── Detectors ─────────────────────────────────────────────────────────

/**
 * Detect skeleton pages — headings only, no real paragraph content.
 * A paragraph line is >=20 chars, not a heading, code fence, or list marker.
 */
function detectSkeletonPage(body: string): ContentQualityIssue | null {
  const lines = body.split("\n");
  let paragraphCount = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (
      trimmed.length >= 20 &&
      !trimmed.startsWith("#") &&
      !trimmed.startsWith("```") &&
      !trimmed.startsWith("- ") &&
      !trimmed.startsWith("* ") &&
      !trimmed.startsWith("> ") &&
      !/^\d+\.\s/.test(trimmed)
    ) {
      paragraphCount++;
    }
  }
  if (paragraphCount >= 2) return null;

  return {
    check: "skeletonPage",
    severity: "hard",
    message: `Only ${paragraphCount} paragraph line(s) found — page appears to be headings-only skeleton`,
    fixInstruction:
      "Each section needs substantive paragraph prose, not just headings or bullet lists. " +
      "Write at least 2-3 sentences of explanatory text under every ## heading. " +
      "Bullets enumerate; they do not replace explanation.",
  };
}

export function detectRestEndpointDuplicateSection(
  body: string,
): ContentQualityIssue | null {
  const duplicate = findRestEndpointDuplicateSection(body);
  if (!duplicate) return null;

  return {
    check: "restEndpointDuplicateSection",
    severity: "hard",
    message: `REST endpoint page repeats the renderer-owned section "${duplicate.heading}"`,
    location: {
      line: duplicate.line,
      snippet: duplicate.source,
    },
    fixInstruction:
      `Remove the heading "${duplicate.heading}" and its section. ` +
      "The REST endpoint renderer already shows this content.",
    autoFix: (candidate) => removeRestEndpointDuplicateSection(candidate, duplicate),
  };
}

/**
 * Detect content that ends mid-sentence (cutoff).
 * The last non-empty line should end with sentence-terminal punctuation
 * or a code fence.
 */
/**
 * Detect a credential copied into the page, such as a key from the
 * repository. The snippet masks the value, so the retry prompt does not
 * repeat it.
 */
function detectLeakedSecret(body: string): ContentQualityIssue | null {
  const secret = findSecret(body);
  if (!secret) return null;

  const line = body.slice(0, secret.index).split("\n").length - 1;
  const value = body.slice(secret.index, secret.index + secret.length);
  const masked = `${value.slice(0, 6)}…`;
  return {
    check: "leakedSecret",
    severity: "hard",
    message: `The page contains what looks like a real credential (${masked}).`,
    location: { line, snippet: masked },
    fixInstruction:
      "Replace the credential with a clear placeholder such as `YOUR_API_KEY`. " +
      "Never copy a real key, token, or private key from the repository into the docs.",
    fixExample: { bad: "Authorization: Bearer sk-ant-api03-…", good: "Authorization: Bearer YOUR_API_KEY" },
  };
}

/**
 * Detect raw HTML that a generated page never needs, such as `<script>` or a
 * raw `<a>`. Hidden classes and outside media are removed at the final
 * compose step instead, so they need no retry.
 */
function detectUnsafeMarkup(body: string): ContentQualityIssue | null {
  const unsafe = findUnsafeMarkup(body);
  if (!unsafe) return null;
  return {
    check: "unsafeMarkup",
    severity: "hard",
    message: `The page contains raw HTML that docs pages do not allow (${unsafe.reason}).`,
    location: { line: unsafe.line, snippet: unsafe.snippet },
    fixInstruction:
      "Remove the raw HTML. Use a Markdown link `[text](url)` instead of `<a>`, and the registered MDX " +
      "components for everything else. Never add scripts, styles, frames, forms, event handlers or hidden content.",
    fixExample: { bad: '<a href="https://example.com">Example</a>', good: "[Example](https://example.com)" },
  };
}

function detectCutoffContent(body: string): ContentQualityIssue | null {
  const lines = body.split("\n");
  let lastNonEmpty = "";
  let lastNonEmptyIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim().length > 0) {
      lastNonEmpty = lines[i].trim();
      lastNonEmptyIdx = i;
      break;
    }
  }
  if (!lastNonEmpty) return null;
  if (/[.!?:;\])|>`]$/.test(lastNonEmpty)) return null;
  if (lastNonEmpty === "```" || lastNonEmpty.startsWith("```")) return null;
  if (lastNonEmpty.startsWith("#")) return null;
  if (/^[-*]\s/.test(lastNonEmpty) || /^\d+\.\s/.test(lastNonEmpty)) {
    if (/[.!?:;\])|>`]$/.test(lastNonEmpty)) return null;
  }

  return {
    check: "cutoffContent",
    severity: "soft",
    message: `Content appears cut off mid-sentence: "${lastNonEmpty.slice(-60)}"`,
    location: { line: lastNonEmptyIdx, snippet: lastNonEmpty },
    fixInstruction:
      "Your previous output ended mid-sentence. Make sure every paragraph ends with " +
      "complete punctuation (`.`, `?`, `!`) and the page ends on a fully closed thought.",
    autoFix: (body) => trimToLastCompleteSentence(body),
  };
}

/**
 * Detect unclosed code blocks (odd number of ``` lines).
 */
function detectUnclosedCodeBlocks(body: string): ContentQualityIssue | null {
  const fenceLines = body.split("\n").filter((l) => l.trim().startsWith("```"));
  if (fenceLines.length % 2 === 0) return null;

  return {
    check: "unclosedCodeBlock",
    severity: "soft",
    message: `Found ${fenceLines.length} code fence lines (odd) — unbalanced fences`,
    fixInstruction:
      "You probably wrapped your entire output in an outer ```markdown ... ``` fence. " +
      "Do NOT wrap your output in any outer code fence — only inner code examples should be fenced. " +
      "The first character of your response must be `-` (the first dash of frontmatter), " +
      "and every inner ``` opener must have a matching closer.",
    fixExample: {
      bad: 'Here is the page:\n\n```markdown\n---\ntitle: ...\n---\n\n## Section\n```',
      good: '---\ntitle: ...\ndescription: ...\n---\n\n## Section\n\nProse paragraph here.',
    },
    autoFix: (body) => `${body.replace(/\s+$/, "")}\n\`\`\`\n`,
  };
}

/**
 * Detect trailing heading with no content after it.
 */
function detectTrailingHeadings(body: string): ContentQualityIssue | null {
  const lines = body.split("\n");
  let lastNonEmpty = "";
  let lastNonEmptyIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim().length > 0) {
      lastNonEmpty = lines[i].trim();
      lastNonEmptyIdx = i;
      break;
    }
  }
  if (!lastNonEmpty.startsWith("#")) return null;

  return {
    check: "trailingHeading",
    severity: "soft",
    message: `Page ends with a heading ("${lastNonEmpty}") but no content follows`,
    location: { line: lastNonEmptyIdx, snippet: lastNonEmpty },
    fixInstruction:
      `Your previous output ended with a heading "${lastNonEmpty}" with no body content. ` +
      "Either write a complete section under that heading, or remove the heading entirely.",
    autoFix: (body) => removeTrailingHeading(body),
  };
}

/**
 * Flag any heading whose text contains inline code, bold, italic, or MDX/JSX
 * tags. Allowed decoration: leading numbering like "1) Foo" or "Step 1: Foo".
 * Hard issue — descriptive plain-text headings require regeneration, not
 * mechanical stripping (auto-fix would lose intent in the heading text).
 */
function detectHeadingsWithStyling(body: string): ContentQualityIssue | null {
  const lines = body.split("\n");
  const offenders: { line: number; text: string; reason: string }[] = [];
  let inFence = false;
  let fenceMarker: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0].repeat(3);
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (line.trimStart().startsWith(fenceMarker!)) {
        inFence = false;
        fenceMarker = null;
      }
      continue;
    }
    if (inFence) continue;

    const level = getHeadingLevel(line);
    if (level === null) continue;
    const text = line.slice(level).trim();
    const reason = headingStylingReason(text);
    if (reason) offenders.push({ line: i, text: line, reason });
  }

  if (offenders.length === 0) return null;

  const first = offenders[0];
  const sampleList = offenders
    .slice(0, 5)
    .map((o) => `  - "${o.text}" (${o.reason})`)
    .join("\n");

  return {
    check: "headingWithStyling",
    severity: "hard",
    message: `${offenders.length} heading(s) contain inline code or styling`,
    location: { line: first.line, snippet: first.text },
    fixInstruction:
      "Headings (h2–h6) must be pure plain text. Remove inline code spans " +
      "(backticks), bold (**...**), italic (_..._), and any MDX/JSX from " +
      "every heading. Rewrite each heading as a short descriptive phrase " +
      '(numbering like "1) " or "Step 1: " is allowed). Offending headings:\n' +
      sampleList,
    fixExample: {
      bad: "## Configure `auth.ts`",
      good: "## Configure the auth module",
    },
  };
}

function headingStylingReason(text: string): string | null {
  if (/`[^`]+`/.test(text)) return "contains inline code";
  if (/\*\*[^*]+\*\*/.test(text)) return "contains bold";
  if (/(^|\s)\*[^*\s][^*]*\*(\s|$)/.test(text)) return "contains italic *...*";
  if (/(^|\s)_[^_\s][^_]*_(\s|$)/.test(text)) return "contains italic _..._";
  if (/<[A-Za-z][^>]*>/.test(text)) return "contains MDX/JSX tag";
  return null;
}

/**
 * Components the writer is allowed to emit as MDX JSX. Mirrors the registry
 * documented in the bundled component playbook. The balance check only
 * considers tags whose name is in this list — bare HTML elements like
 * `<br/>` or arbitrary inline JSX in code fences are left alone.
 */
export const KNOWN_COMPONENTS = RUNTIME_MDX_COMPONENT_NAMES;
const knownComponentNames = new Set<string>(KNOWN_COMPONENTS);

interface JsxTagOccurrence {
  /** Component name. */
  name: string;
  /** "open" = `<Tag …>` (paired) ; "close" = `</Tag>` ; "self" = `<Tag …/>`. */
  kind: "open" | "close" | "self";
  /** 0-based line number where the tag was found. */
  line: number;
  /** Original line text (trimmed) for snippet quoting. */
  snippet: string;
}

/**
 * Walk the body line-by-line, skipping content inside fenced code blocks,
 * and yield every JSX-tag occurrence whose component name is in
 * {@link KNOWN_COMPONENTS}.
 */
function collectJsxTagOccurrences(body: string): JsxTagOccurrence[] {
  const lines = body.split("\n");
  const occurrences: JsxTagOccurrence[] = [];
  let inFence = false;

  // Combined regex matches `<Tag…/>`, `<Tag…>`, and `</Tag>`. The leading
  // "<" plus optional "/" disambiguates open/close. We do NOT anchor to
  // `^<` — opening tags are commonly followed by other text on the line
  // (rare but valid in inline JSX). Names are validated against the known
  // set in the consumer loop below.
  const tagRegex = /<\s*(\/?)\s*([A-Z][A-Za-z0-9]*)\b([^>]*?)(\/?)\s*>/g;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    tagRegex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = tagRegex.exec(line)) !== null) {
      const [, slashStart, name, , slashEnd] = match;
      if (!knownComponentNames.has(name)) continue;

      const kind: JsxTagOccurrence["kind"] = slashStart === "/"
        ? "close"
        : slashEnd === "/"
        ? "self"
        : "open";

      occurrences.push({
        name,
        kind,
        line: i,
        snippet: line.trim(),
      });
    }
  }

  return occurrences;
}

/**
 * Detect MDX-JSX tags whose openers and closers don't balance per
 * component. Self-closing tags are balanced by definition. The returned
 * issue carries an autoFix that resolves the most common failure modes:
 *
 *   - Extra trailing closer (model writes `</Tabs></Tabs>`): drop the
 *     duplicate at its original line.
 *   - Missing closer at end of body: append the matching `</Tag>` line.
 *
 * When the imbalance is interior or ambiguous, autoFix is omitted so the
 * page is forced into a regeneration retry instead of risking a wrong fix.
 */
function detectUnbalancedJsxTags(body: string): ContentQualityIssue | null {
  const occurrences = collectJsxTagOccurrences(body);
  if (occurrences.length === 0) return null;

  // Tally per-component opens vs closes.
  const counts = new Map<string, { open: number; close: number }>();
  for (const occ of occurrences) {
    if (occ.kind === "self") continue;
    const tally = counts.get(occ.name) ?? { open: 0, close: 0 };
    if (occ.kind === "open") tally.open++;
    else tally.close++;
    counts.set(occ.name, tally);
  }

  const imbalances: Array<{ name: string; delta: number }> = [];
  for (const [name, { open, close }] of counts) {
    const delta = open - close;
    if (delta !== 0) imbalances.push({ name, delta });
  }

  if (imbalances.length === 0) return null;

  // Pick the first imbalance for the message; all imbalances are addressed
  // by the auto-fix below, but the retry hint reads more naturally if it
  // names a concrete component.
  const primary = imbalances[0];
  const sign = primary.delta > 0 ? "missing" : "extra";
  const offenders = occurrences.filter((o) => o.name === primary.name);
  const offenderForLocation = primary.delta < 0
    ? findDuplicateClose(offenders) ?? offenders[offenders.length - 1]
    : offenders[offenders.length - 1];

  return {
    check: "unbalancedJsxTags",
    severity: "soft",
    message:
      `Unbalanced <${primary.name}> tags: ` +
      `${Math.abs(primary.delta)} ${sign} ${primary.delta > 0 ? "closer" : "closer(s)"}` +
      (imbalances.length > 1
        ? ` (and ${imbalances.length - 1} other component${imbalances.length - 1 === 1 ? "" : "s"})`
        : ""),
    location: offenderForLocation
      ? { line: offenderForLocation.line, snippet: offenderForLocation.snippet }
      : undefined,
    fixInstruction:
      "Every JSX component opener must have exactly one matching closer " +
      "(self-closing `<Tag/>` counts as both). On your previous attempt, " +
      `<${primary.name}> had ${Math.abs(primary.delta)} ${sign} ${primary.delta > 0 ? "closer" : "closer(s)"}. ` +
      "Pair every opener with its closer. Use self-closing form (`<Tag/>`) for components with no children.",
    fixExample: {
      bad: "<Tabs>\n  <TabsContent>x</TabsContent>\n</Tabs>\n</Tabs>",
      good: "<Tabs>\n  <TabsContent>x</TabsContent>\n</Tabs>",
    },
    autoFix: (body) => repairUnbalancedJsxTags(body, imbalances),
  };
}

/**
 * Locate a duplicate consecutive closer (the deployment-page failure mode):
 * `</Tag>` immediately followed by another `</Tag>` on the next non-blank
 * line. Returns the second occurrence — the one we'd drop on auto-fix.
 */
function findDuplicateClose(occurrences: JsxTagOccurrence[]): JsxTagOccurrence | null {
  const closes = occurrences.filter((o) => o.kind === "close");
  for (let i = 1; i < closes.length; i++) {
    if (closes[i].line - closes[i - 1].line <= 2) {
      return closes[i];
    }
  }
  return null;
}

/**
 * Best-effort repair: strip duplicate trailing closers, append missing ones.
 * Conservative — only acts on unambiguous patterns. When the fix wouldn't
 * obviously help, it returns the body unchanged so the writer pipeline
 * surfaces the issue as a warning rather than corrupting the page.
 */
function repairUnbalancedJsxTags(
  body: string,
  imbalances: Array<{ name: string; delta: number }>,
): string {
  let result = body;

  for (const { name, delta } of imbalances) {
    if (delta < 0) {
      // Extra closer(s). Drop duplicate consecutive `</Name>` lines.
      const lines = result.split("\n");
      let dropsRemaining = -delta;
      const closeLineRegex = new RegExp(`^\\s*<\\s*/\\s*${name}\\s*>\\s*$`);
      for (let i = lines.length - 1; i > 0 && dropsRemaining > 0; i--) {
        if (!closeLineRegex.test(lines[i])) continue;
        // Walk back to find the previous non-blank line.
        let prev = i - 1;
        while (prev >= 0 && lines[prev].trim() === "") prev--;
        if (prev >= 0 && closeLineRegex.test(lines[prev])) {
          lines.splice(i, 1);
          dropsRemaining--;
        }
      }
      result = lines.join("\n");
    } else if (delta > 0) {
      // Missing closer(s). Append at end (best-effort — interior closers
      // can't be reliably inserted without a real parser).
      const trailing = `</${name}>\n`.repeat(delta);
      result = result.replace(/\s+$/, "") + "\n" + trailing;
    }
  }

  return result;
}

/**
 * Detect empty sections — a heading followed by another heading at the same
 * or shallower depth with no prose between. Deeper headings (e.g. `### Child`
 * after `## Parent`) are allowed: that's legitimate nesting, not emptiness.
 */
function detectEmptySections(body: string): ContentQualityIssue | null {
  const lines = body.split("\n");
  let lastHeading: { line: string; level: number; lineNo: number } | null = null;
  let hasContentSinceHeading = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const level = getHeadingLevel(trimmed);

    if (level !== null) {
      if (lastHeading && !hasContentSinceHeading && level <= lastHeading.level) {
        const snippetLines = lines.slice(lastHeading.lineNo, i + 1);
        return {
          check: "emptySection",
          severity: "hard",
          message: `Empty section: "${lastHeading.line}" has no prose before next ${"#".repeat(level)} heading`,
          location: {
            line: lastHeading.lineNo,
            snippet: snippetLines.join("\n"),
          },
          fixInstruction:
            `Write 2-4 sentences of introductory prose under "${lastHeading.line}" before the next ` +
            "same-or-higher-level heading. The intro should frame the sub-sections that follow. " +
            "Sub-headings at deeper levels (more `#`s) are allowed without prose between, but a parent " +
            "section needs an intro paragraph.",
        };
      }
      lastHeading = { line: trimmed, level, lineNo: i };
      hasContentSinceHeading = false;
    } else if (trimmed.length > 0) {
      hasContentSinceHeading = true;
    }
  }

  return null;
}

const STEP_FIX_EXAMPLE = {
  bad:
    '<Step title="Install the SDK">\n\nRun `npm install @acme/sdk`.\n\n</Step>\n\n' +
    '<Step title="Initialize the client">\n\nCreate the client once.\n\n</Step>',
  good:
    '<Step>\n<StepItem title="Install the SDK">\n\nRun `npm install @acme/sdk`.\n\n</StepItem>\n\n' +
    '<StepItem title="Initialize the client">\n\nCreate the client once.\n\n</StepItem>\n</Step>',
};

const STEP_PROBLEM_MESSAGES: Record<Exclude<StepProblemKind, "titledStep">, string> = {
  stepProps: "<Step> takes no props",
  looseContent: "content sits directly inside <Step>, outside a <StepItem>",
  orphanStepItem: "<StepItem> is not inside a <Step>",
};

/**
 * Detect `<Step>` blocks the renderer cannot draw as numbered steps. The
 * renderer numbers every child element of `<Step>`, so a title on `<Step>` is
 * dropped and each paragraph or code block becomes its own step. The
 * `<Step title="…">` shape alone is rewritten by the autoFix; any other misuse
 * needs a rewrite by the model.
 */
function detectStepStructure(body: string): ContentQualityIssue | null {
  const problems = findStepProblems(body);
  if (problems.length === 0) return null;

  const fixInstruction =
    "Write every numbered procedure as ONE `<Step>` (no props) whose only children are " +
    '`<StepItem title="…">` elements, one per step. Put the step text and code blocks inside ' +
    "its `<StepItem>`, with a blank line before and after each code fence. " +
    "Never write `<Step title=…>`, never put text or code directly inside `<Step>`, and never use " +
    "`<StepItem>` outside a `<Step>`.";

  const unfixable = problems.filter((problem) => problem.kind !== "titledStep");
  if (unfixable.length === 0) {
    const first = problems[0]!;
    return {
      check: "stepStructure",
      severity: "soft",
      message:
        `${problems.length} <Step title="…"> block(s): <Step> takes no title, so the renderer ` +
        "drops it and numbers every paragraph and code block as a step",
      location: { line: first.line, snippet: first.snippet },
      fixInstruction,
      fixExample: STEP_FIX_EXAMPLE,
      autoFix: normalizeStepBlocks,
    };
  }

  const first = unfixable[0]!;
  const kind = first.kind as Exclude<StepProblemKind, "titledStep">;
  return {
    check: "stepStructure",
    severity: "hard",
    message:
      `Invalid <Step> structure: ${STEP_PROBLEM_MESSAGES[kind]}` +
      (problems.length > 1 ? ` (${problems.length} problems in all)` : ""),
    location: { line: first.line, snippet: first.snippet },
    fixInstruction,
    fixExample: STEP_FIX_EXAMPLE,
  };
}

// ─── Auto-fix Helpers ──────────────────────────────────────────────────

function removeTrailingHeading(body: string): string {
  const lines = body.split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  if (lines.length > 0 && lines[lines.length - 1].trim().startsWith("#")) {
    lines.pop();
  }
  return lines.join("\n").replace(/\s+$/, "") + "\n";
}

function trimToLastCompleteSentence(body: string): string {
  const trimmed = body.replace(/\s+$/, "");
  const match = trimmed.match(/^([\s\S]*?[.!?:])\s*[^.!?:]*$/);
  if (!match) return body;
  return match[1] + "\n";
}

// ─── Public Entry Points ───────────────────────────────────────────────

const DETECTORS: ReadonlyArray<(body: string) => ContentQualityIssue | null> = [
  detectLeakedSecret,
  detectUnsafeMarkup,
  detectSkeletonPage,
  detectCutoffContent,
  detectUnclosedCodeBlocks,
  detectUnbalancedJsxTags,
  detectStepStructure,
  detectTrailingHeadings,
  detectEmptySections,
  detectHeadingsWithStyling,
];

/**
 * Run all content-quality checks on a page body.
 * Returns whether the content is acceptable plus an aggregated retry hint
 * for callers that don't use the structured {@link buildRetryHint}.
 */
export function checkContentQuality(body: string): ContentQualityResult {
  const issues: ContentQualityIssue[] = [];
  for (const detector of DETECTORS) {
    const issue = detector(body);
    if (issue) issues.push(issue);
  }

  if (issues.length === 0) {
    return { acceptable: true, issues, retryHint: "" };
  }

  const retryHint = [
    "IMPORTANT — Content quality issues detected:",
    ...issues.map((issue) => `- ${issue.fixInstruction}`),
  ].join("\n");

  return { acceptable: false, issues, retryHint };
}

/**
 * Apply registered `autoFix` transforms for soft issues. Hard issues are
 * skipped — they require regeneration. Returns the patched body and the
 * subset of issues whose fixes were applied.
 */
export function applyAutoFixes(
  body: string,
  issues: ContentQualityIssue[],
): { body: string; applied: ContentQualityIssue[] } {
  let patched = body;
  const applied: ContentQualityIssue[] = [];
  for (const issue of issues) {
    if (issue.severity !== "soft" || !issue.autoFix) continue;
    patched = issue.autoFix(patched);
    applied.push(issue);
  }
  return { body: patched, applied };
}

// ─── Unified Validation Surface ───────────────────────────────────────

/**
 * Stable issue shape returned to the writer's `validate_page` tool and used
 * by the server-side gate. A superset of {@link ContentQualityIssue} that
 * also carries frontmatter and MDX-parse errors under one common type.
 */
export interface ToolValidationIssue {
  /** Stable id — e.g. "mdx-parse", "skeletonPage", "frontmatter.title". */
  rule: string;
  severity: IssueSeverity;
  /** 1-indexed source line, when known. */
  line?: number;
  col?: number;
  /** Up to ~240 chars of surrounding source. */
  snippet?: string;
  /** Short human-readable summary. */
  message: string;
  /** Model-facing instruction for what to change on retry. */
  hint: string;
}

export interface ToolValidationReport {
  /** True iff zero `hard` issues. Soft-only pages still report `ok: true`. */
  ok: boolean;
  issues: ToolValidationIssue[];
}

export interface RunPageValidationOptions extends PageValidationOptions {
  /** Reject renderer-owned sections on deterministic REST endpoint pages. */
  restEndpointPage?: boolean;
  /** Run the MDX parse pass via subprocess. Default true. */
  mdxCompile?: boolean;
  /** Subprocess timeout in ms for the MDX pass. Default 10000. */
  timeoutMs?: number;
  /** Reject body content shorter than this many characters. Default 200. */
  minBodyLength?: number;
  /** Receives MDX validation timing spans. */
  onSpan?: AgentSpanCallback;
  /**
   * Exact values that no page may contain, such as the credentials of this
   * run. Known key formats are rejected without this list.
   */
  forbiddenValues?: readonly string[];
}

const SNIPPET_MAX = 240;

function truncateSnippet(s: string | undefined): string | undefined {
  if (!s) return undefined;
  if (s.length <= SNIPPET_MAX) return s;
  return `${s.slice(0, SNIPPET_MAX)}…`;
}

function fromValidationError(e: ValidationError): ToolValidationIssue {
  const isBodyMetadata = e.field === "body" || e.field === "body-frontmatter-artifact";
  return {
    rule: e.field,
    severity: e.severity === "error" ? "hard" : "soft",
    message: e.message,
    hint: isBodyMetadata
      ? "Remove the duplicated metadata block from the body. Emit metadata only once, in the canonical frontmatter at the very top of the page."
      : e.severity === "error"
        ? `Fix the frontmatter field \`${e.field}\` so the page parses correctly: ${e.message}.`
        : `Frontmatter field \`${e.field}\` looks suspicious: ${e.message}. Clean it up so the schema is unambiguous.`,
    ...(e.line !== undefined ? { line: e.line } : {}),
    ...(e.snippet ? { snippet: truncateSnippet(e.snippet) } : {}),
  };
}

function fromContentQualityIssue(
  i: ContentQualityIssue,
  bodyStartLine: number,
): ToolValidationIssue {
  return {
    rule: i.check,
    severity: i.severity,
    message: i.message,
    hint: i.fixInstruction,
    ...(i.location?.line !== undefined ? { line: bodyStartLine + i.location.line } : {}),
    ...(i.location?.snippet ? { snippet: truncateSnippet(i.location.snippet) } : {}),
  };
}

function fromMdxCompileError(e: MdxCompileError): ToolValidationIssue {
  return {
    rule: e.rule,
    severity: e.severity,
    line: e.line || undefined,
    col: e.col || undefined,
    snippet: truncateSnippet(e.snippet),
    message: e.message,
    hint:
      e.rule === "validator-crashed"
        ? "The MDX validator could not run. Treat this as a hard failure and re-emit a clean page; ensure no malformed JSX, unclosed code fences, or stray `<` characters in prose."
        : e.rule === "mdx-runtime-incompatible"
          ? "Use only the documented MDX components and syntax supported by the renderer. Remove imports, expressions, ESM, and invented component names."
        : "Your output failed MDX parsing. Fix the JSX or expression at the line/snippet above. Common causes: unbalanced `<Tabs>`/`<TabsContent>`/`<Step>`/`<StepItem>`, raw `<` in prose (escape with `&lt;` or backticks), or attribute syntax errors.",
  };
}

/**
 * Aggregate every page-level check into one structured report.
 *
 * Runs frontmatter validation, body content-quality detectors, and (unless
 * disabled) the MDX subprocess parse pass. Output is the `ToolValidationReport`
 * the `validate_page` tool returns to the model and the writer pipeline's
 * server-side gate consumes.
 */
export async function runPageValidation(
  content: string,
  opts: RunPageValidationOptions = {},
): Promise<ToolValidationReport> {
  const issues: ToolValidationIssue[] = [];

  const frontmatterResult = validatePage(content, opts);
  for (const err of frontmatterResult.errors) {
    issues.push(fromValidationError(err));
  }

  // checkContentQuality runs over the body only — strip frontmatter first so
  // detectors don't trip on `--- title: …` blocks.
  const { body } = parseFrontmatter(frontmatterResult.cleaned);
  const bodyOffset = frontmatterResult.cleaned.indexOf(body);
  const bodyStartLine = bodyOffset > 0
    ? frontmatterResult.cleaned.slice(0, bodyOffset).split("\n").length
    : 1;
  const minBodyLength = opts.minBodyLength ?? 200;
  if (body.trim().length < minBodyLength) {
    issues.push({
      rule: "tooShort",
      severity: "hard",
      message: `Body has only ${body.trim().length} chars (min ${minBodyLength})`,
      hint:
        "Expand each section with concrete examples, code snippets, and explanatory prose drawn from the actual codebase. " +
        "Include at least one full paragraph under every level-two heading.",
    });
  }
  const quality = checkContentQuality(body);
  for (const issue of quality.issues) {
    issues.push(fromContentQualityIssue(issue, bodyStartLine));
  }
  if (opts.restEndpointPage) {
    const duplicateSection = detectRestEndpointDuplicateSection(body);
    if (duplicateSection) {
      issues.push(fromContentQualityIssue(duplicateSection, bodyStartLine));
    }
  }

  if (containsForbiddenValue(content, opts.forbiddenValues)) {
    // No line or snippet: the retry prompt must not repeat the value.
    issues.push({
      rule: "forbiddenValue",
      severity: "hard",
      message: "The page contains a secret value of this generation run.",
      hint:
        "Remove the secret value. Never copy a credential, token or environment value into the docs; " +
        "use a clear placeholder such as `YOUR_API_KEY`.",
    });
  }

  const allowed = loadAllowedComponents();
  const referenced = extractMdxComponents(content);
  const unknownComponents = referenced.filter((name) => !allowed.has(name));
  let unknownComponentsToReport = unknownComponents;

  if (opts.mdxCompile !== false) {
    const compileResult = await compileMdx(content, {
      timeoutMs: opts.timeoutMs,
      onSpan: opts.onSpan,
    });
    const runtimeUnknownComponents = unknownComponents.filter((name) =>
      compileResult.errors.some(
        (error) =>
          error.rule === "mdx-runtime-incompatible" &&
          error.message.includes(name),
      )
    );
    unknownComponentsToReport = compileResult.ok
      ? unknownComponents
      : runtimeUnknownComponents;

    for (const err of compileResult.errors) {
      if (
        err.rule === "mdx-runtime-incompatible" &&
        runtimeUnknownComponents.some((name) => err.message.includes(name))
      ) {
        continue;
      }
      issues.push(fromMdxCompileError(err));
    }
  }

  for (const name of unknownComponentsToReport) {
    issues.push(fromUnknownComponent(name, allowed));
  }

  const ok = issues.every((i) => i.severity !== "hard");
  // Any detector can quote the line with a secret, and the report goes back
  // into the next model prompt.
  return { ok, issues: issues.map((issue) => maskIssueSecrets(issue, opts.forbiddenValues)) };
}

function maskIssueSecrets(issue: ToolValidationIssue, forbiddenValues: readonly string[] | undefined): ToolValidationIssue {
  const mask = (text: string) => forbiddenValueVariants(forbiddenValues)
    .reduce((current, value) => current.split(value).join(REDACTED), new SecretRedactor().redact(text));
  return {
    ...issue,
    message: mask(issue.message),
    hint: mask(issue.hint),
    ...(issue.snippet !== undefined ? { snippet: mask(issue.snippet) } : {}),
  };
}

/** Matches a forbidden value as written, URL-encoded or base64-encoded. */
export function containsForbiddenValue(content: string, values: readonly string[] | undefined): boolean {
  return forbiddenValueVariants(values).some((candidate) => content.includes(candidate));
}

function forbiddenValueVariants(values: readonly string[] | undefined): string[] {
  return (values ?? [])
    .filter((value) => value.length > 0)
    .flatMap((value) => [value, encodeURIComponent(value), Buffer.from(value).toString("base64")]);
}

function fromUnknownComponent(
  name: string,
  allowed: Set<string>,
): ToolValidationIssue {
  const allowedList = Array.from(allowed).sort().join(", ");
  return {
    rule: "unknown-component",
    severity: "hard",
    message: `Unknown MDX component <${name}> — not registered by the Doxa MDX runtime.`,
    hint:
      `Replace <${name}> with one of the registered components: ${allowedList}. ` +
      `If you wanted a callout, use <Note type="warning"> (or "danger" / "info"). ` +
      `If you wanted a tip card, use <Card>. Never invent component names — only the registered list will render.`,
  };
}
