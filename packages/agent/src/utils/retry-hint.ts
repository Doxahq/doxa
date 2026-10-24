/**
 * Compact validation feedback for writer retries.
 *
 * The structured history keeps complete diagnostics, while the rendered
 * prompt includes only the latest actionable details and compact identities
 * for older failures. This prevents retry context from growing with every
 * failed attempt.
 */

import type { ContentQualityIssue } from "./page-validator";

const EXCERPT_BUDGET = 6_000;
const EXCERPT_HALF = EXCERPT_BUDGET / 2;
const CURRENT_OUTPUT_BUDGET = 800;
const ISSUE_DETAIL_BUDGET = 560;
const ISSUE_MESSAGE_BUDGET = 160;
const ISSUE_FIX_BUDGET = 220;
const ISSUE_SNIPPET_BUDGET = 140;

export const RETRY_FEEDBACK_MAX_CHARS = 6_000;

export interface ValidationHistoryEntry {
  pageRetry: number;
  attempt: number;
  maxAttempts: number;
  issues: ContentQualityIssue[];
  rawContent: string;
  debugPath: string;
  finishReason?: string;
}

export interface RetryHintInput extends ValidationHistoryEntry {
  previousAttempts?: readonly ValidationHistoryEntry[];
}

/** Render one current failure and all prior failures for the same page. */
export function buildRetryHint(input: RetryHintInput): string {
  const previousAttempts = input.previousAttempts ?? [];
  const historyLines = previousAttempts.map(formatHistoricalAttempt);
  const fixedLines = [
    "RETRY VALIDATION",
    `FIX NOW ${attemptId(input)}`,
    ...(historyLines.length > 0 ? ["AVOID REGRESSIONS", ...historyLines] : []),
    "Return corrected MDX only.",
  ];

  const minimumCurrentLines = input.issues.length > 0
    ? input.issues.map((issue) => `- ${issueIdentity(issue)}`)
    : ["- Repair the latest failed output."];
  const includeOutputExcerpt = input.issues.length === 0
    || input.finishReason === "length"
    || input.issues.every((issue) => !issue.location?.snippet.trim());
  const outputLineOverhead = includeOutputExcerpt && input.issues.length > 0
    ? "\n- Output: ".length
    : 0;
  const issueDetailOverhead = input.issues.length * 2;
  const fixedLength = fixedLines.join("\n").length
    + minimumCurrentLines.join("\n").length
    + outputLineOverhead
    + issueDetailOverhead
    + 2;
  const detailBudget = Math.max(0, RETRY_FEEDBACK_MAX_CHARS - fixedLength);
  const excerptReserve = includeOutputExcerpt && input.issues.length > 0
    ? Math.min(160, detailBudget)
    : 0;
  const perIssueBudget = input.issues.length > 0
    ? Math.min(
        ISSUE_DETAIL_BUDGET,
        Math.floor((detailBudget - excerptReserve) / input.issues.length),
      )
    : Math.min(CURRENT_OUTPUT_BUDGET, detailBudget);
  const usedIssueBudget = perIssueBudget * input.issues.length;
  const outputExcerptBudget = input.issues.length > 0
    ? Math.min(CURRENT_OUTPUT_BUDGET, Math.max(0, detailBudget - usedIssueBudget))
    : perIssueBudget;

  const currentLines = input.issues.length > 0
    ? [
        ...input.issues.map((issue) => formatCurrentIssue(issue, perIssueBudget)),
        ...(includeOutputExcerpt && outputExcerptBudget > 0
          ? [`- Output: ${truncate(singleLine(input.rawContent), outputExcerptBudget)}`]
          : []),
      ]
    : [formatFallbackOutput(input.rawContent, perIssueBudget)];

  const lines = [
    "RETRY VALIDATION",
    `FIX NOW ${attemptId(input)}`,
    ...currentLines,
    ...(historyLines.length > 0 ? ["AVOID REGRESSIONS", ...historyLines] : []),
    "Return corrected MDX only.",
  ];

  // Field-level budgets keep normal output below the ceiling. This final
  // guard applies only to pathological rule names or unusually many issues.
  return truncate(lines.join("\n"), RETRY_FEEDBACK_MAX_CHARS);
}

/** Render a complete per-page ledger with its latest entry as outstanding. */
export function renderValidationHistory(
  history: readonly ValidationHistoryEntry[],
): string | undefined {
  const current = history.at(-1);
  if (!current) return undefined;
  return buildRetryHint({
    ...current,
    previousAttempts: history.slice(0, -1),
  });
}

function formatCurrentIssue(issue: ContentQualityIssue, detailBudget: number): string {
  const identity = issueIdentity(issue);
  const details = [
    truncate(singleLine(issue.message), ISSUE_MESSAGE_BUDGET),
    issue.fixInstruction
      ? `Fix: ${truncate(singleLine(issue.fixInstruction), ISSUE_FIX_BUDGET)}`
      : "",
    issue.location?.snippet
      ? `Snip: ${truncate(singleLine(issue.location.snippet), ISSUE_SNIPPET_BUDGET)}`
      : "",
  ].filter(Boolean).join(" ");
  return details && detailBudget > 2
    ? `- ${identity}: ${truncate(details, detailBudget)}`
    : `- ${identity}`;
}

function formatHistoricalAttempt(entry: ValidationHistoryEntry): string {
  const identities = entry.issues.length > 0
    ? entry.issues.map(issueIdentity).join(", ")
    : "unstructured-failure";
  return `- ${attemptId(entry)} ${identities}`;
}

function formatFallbackOutput(rawContent: string, budget: number): string {
  const excerpt = singleLine(rawContent);
  return excerpt && budget > 2
    ? `- Repair output: ${truncate(excerpt, budget)}`
    : "- Repair the latest failed output.";
}

function attemptId(entry: Pick<ValidationHistoryEntry, "pageRetry" | "attempt">): string {
  return `r${entry.pageRetry}.a${entry.attempt}`;
}

function issueIdentity(issue: ContentQualityIssue): string {
  const line = issue.location ? `@${issue.location.line + 1}` : "";
  return `${singleLine(issue.check)}${line}`;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 1) return value.slice(0, Math.max(0, maxChars));
  return `${value.slice(0, maxChars - 1).trimEnd()}…`;
}

/**
 * Truncate raw output to a digestible excerpt: head + middle ellipsis + tail.
 * Retained for diagnostic callers; retry prompts use the smaller renderer.
 */
export function buildFailedOutputExcerpt(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length <= EXCERPT_BUDGET) return trimmed;
  return `${trimmed.slice(0, EXCERPT_HALF)}\n...\n${trimmed.slice(-EXCERPT_HALF)}`;
}
