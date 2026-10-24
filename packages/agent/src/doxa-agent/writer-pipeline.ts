/**
 * Writer Pipeline — shared orchestrator
 *
 * Both writer entry points (`writeDocPage` and the tracked-tools variant)
 * went through the same multi-stage attempt loop:
 *
 *   1. Build prompt with optional retry hint.
 *   2. Invoke the provider.
 *   3. Cleanup the raw output (unwrap fences, strip commentary, strip
 *      frontmatter, scrub artifacts).
 *   4. Validate (provider finish reason, content quality, body length,
 *      residual frontmatter).
 *   5. On failure, build a structured retry hint and try again.
 *   6. After the final attempt, gracefully degrade — accept the best
 *      attempt with auto-fixes when only soft issues remain; throw when
 *      a hard issue (e.g. skeletonPage) persists.
 *   7. Compose the final page (canonical frontmatter, ensure heading,
 *      run the structural validator one last time).
 *
 * This module owns the loop. Callers supply a single `runOnce` callback
 * that does the actual provider call, a `saveDebug` callback for writing
 * failed attempts to disk, and an optional `composeDescription` callback
 * for project-specific description validation.
 */

import { formatMdx } from "@doxahq/mdx-runtime/format";

import {
  applyAutoFixes,
  runPageValidation,
  validatePage,
  type ContentQualityIssue,
  type ToolValidationIssue,
} from "../utils/page-validator";
import { stripAgentCommentary } from "../utils/commentary-patterns";
import {
  cleanBodyArtifacts,
  escapeMdxBraces,
  normalizeFenceLanguages,
  unwrapOuterCodeFence,
} from "../utils/content-cleanup";
import {
  buildFrontmatter,
  composePage,
  parseFrontmatter,
  stripAllFrontmatter,
} from "../utils/frontmatter";
import {
  renderValidationHistory,
  type ValidationHistoryEntry,
} from "../utils/retry-hint";
import { normalizeStepBlocks } from "../utils/step-blocks";
import {
  classifyTargetedRepairIssue,
  type ModelMdxRepairResult,
} from "./mdx-repair-model";
import type {
  TargetedRepairClass,
  WriterDiagnosticCallback,
  WriterRepairDiagnosticCallback,
} from "../types";
import type { AgentLoopReport, AgentSpanCallback } from "../core";

export interface WriterRunResult {
  text: string;
  finishReason?: string;
  loop?: AgentLoopReport;
}

export interface WriterAttemptOptions {
  pageId?: string;
  title: string;
  description: string;
  /** Preserve a deterministic REST method-and-path title verbatim. */
  preserveTitle?: boolean;
  /** REST endpoint metadata rendered separately from the prose title. */
  apiMethod?: string;
  apiPath?: string;
  /** Default 3. */
  maxAttempts?: number;
  /** Default 200. Reject + retry when body is shorter than this. */
  minBodyLength?: number;
  baseTokens: number;
  expandedTokens: number;
  /** Structured feedback from an exhausted outer page attempt. */
  initialRetryHint?: string;
  /** Full validation ledger from earlier runs of this page only. */
  initialValidationHistory?: readonly ValidationHistoryEntry[];
  /** Zero-based outer page retry number. Default 0. */
  pageRetry?: number;
  /** Validation classes eligible for targeted repair. Default: `["mdx"]`. */
  targetedRepairClasses?: TargetedRepairClass[];
  /** Caller invokes the provider with the supplied hint and token budget. */
  runOnce: (params: {
    retryHint?: string;
    maxTokens: number;
    attempt: number;
    pageRetry: number;
  }) => Promise<WriterRunResult>;
  /** Persist a failed attempt to disk for post-mortem; returns the path. */
  saveDebug: (attempt: number, rawContent: string, reason: string) => Promise<string>;
  /** Called for non-fatal warnings (retry messages, accepted-with-fixes notices). */
  onWarn?: (message: string) => void;
  /** Operational attempt diagnostics. Callers decide where these are written. */
  onDiagnostic?: WriterDiagnosticCallback;
  /** Persists the exact failed draft and parser location outside the checkout. */
  onRepairDiagnostic?: WriterRepairDiagnosticCallback;
  /** Runs one bounded model-only repair cycle against the immutable draft. */
  repairMdx?: (input: {
    draft: string;
    issue: ToolValidationIssue;
    repairClass: TargetedRepairClass;
    pageRetry: number;
    writerAttempt: number;
  }) => Promise<ModelMdxRepairResult>;
  /** Optional per-project description validator/normalizer. */
  composeDescription?: (agentDescription: string | null) => string;
  /**
   * Validation gate options. Forwarded to {@link runPageValidation}; the same
   * settings are also handed to the writer's `validate_page` tool so the
   * model and the server-side gate run the exact same checks.
   */
  validation?: {
    /** Run the MDX subprocess parse pass. Default true. */
    mdxCompile?: boolean;
    /** Subprocess timeout in ms. Default 10000. */
    timeoutMs?: number;
    /** Reject sections that the REST endpoint renderer already provides. */
    restEndpointPage?: boolean;
    /** Receives MDX validation timing spans. */
    onSpan?: AgentSpanCallback;
  };
}

export interface WriterAttemptResult {
  /** Final composed page (frontmatter + body), ready to write to disk. */
  content: string;
  /** Number of attempts consumed (1-based). */
  attempts: number;
  /** Soft issues that were auto-fixed during graceful degradation. */
  appliedFixes: ContentQualityIssue[];
  /** Human-readable warnings, one per applied fix. */
  warnings: string[];
}

interface AttemptCandidate {
  rawContent: string;
  body: string;
  agentDescription: string | null;
  issues: ContentQualityIssue[];
}

export class PageValidationExhaustedError extends Error {
  readonly title: string;
  readonly attempts: number;
  readonly issues: ContentQualityIssue[];
  readonly failedContent: string;
  readonly retryHint: string;
  readonly validationHistory: ValidationHistoryEntry[];

  constructor(input: {
    title: string;
    attempts: number;
    issues: ContentQualityIssue[];
    failedContent: string;
    validationHistory: readonly ValidationHistoryEntry[];
  }) {
    const summary = input.issues.map((issue) => issue.check).join(", ");
    super(`Page "${input.title}" failed validation after ${input.attempts} attempts: ${summary}`);
    this.name = "PageValidationExhaustedError";
    this.title = input.title;
    this.attempts = input.attempts;
    this.issues = input.issues;
    this.failedContent = input.failedContent;
    this.validationHistory = cloneValidationHistory(input.validationHistory);
    this.retryHint = renderValidationHistory(this.validationHistory)
      ?? `Repair the previous page and resolve: ${input.issues.map((issue) => issue.message).join("; ")}`;
  }
}

const TOKEN_LIMIT_FIX_INSTRUCTION =
  "Be more concise. Cut redundant prose. Keep code examples minimal " +
  "(only the most representative snippet per concept). Aim for ~60% of " +
  "your previous length while preserving every section.";

export async function runWriterAttempts(
  opts: WriterAttemptOptions,
): Promise<WriterAttemptResult> {
  const max = opts.maxAttempts ?? 3;
  const minBodyLength = opts.minBodyLength ?? 200;
  const targetedRepairClasses =
    opts.targetedRepairClasses ?? ["mdx"];

  const validationHistory = cloneValidationHistory(opts.initialValidationHistory ?? []);
  let retryHint = renderValidationHistory(validationHistory) ?? opts.initialRetryHint;
  let useExpandedTokens = false;
  let bestCandidate: AttemptCandidate | null = null;

  for (let attempt = 1; attempt <= max; attempt++) {
    const pageRetry = opts.pageRetry ?? 0;
    const maxTokens = useExpandedTokens ? opts.expandedTokens : opts.baseTokens;
    const modelStartedAt = Date.now();
    opts.onDiagnostic?.({
      eventType: "writer_attempt_started",
      pageTitle: opts.title,
      pageRetry,
      attempt,
      maxAttempts: max,
      maxTokens,
    });

    let text: string;
    let finishReason: string | undefined;
    let loop: AgentLoopReport | undefined;
    try {
      const result = await opts.runOnce({
        retryHint,
        maxTokens,
        attempt,
        pageRetry,
      });
      text = result.text;
      finishReason = result.finishReason;
      loop = result.loop;
    } catch (error) {
      opts.onDiagnostic?.({
        eventType: "writer_model_failed",
        pageTitle: opts.title,
        pageRetry,
        attempt,
        maxAttempts: max,
        durationMs: Date.now() - modelStartedAt,
        errorName: error instanceof Error ? error.name : "UnknownError",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    const rawContent = text.trim();
    const candidate = cleanRawContent(rawContent);
    opts.onDiagnostic?.({
      eventType: "writer_model_completed",
      pageTitle: opts.title,
      pageRetry,
      attempt,
      maxAttempts: max,
      durationMs: Date.now() - modelStartedAt,
      rawChars: rawContent.length,
      finishReason,
      steps: loop?.steps,
      loopTermination: loop?.termination,
      finalizationTriggered: loop?.finalizationTriggered,
      repeatedToolCallsBlocked: loop?.repeatedToolCallsBlocked,
    });

    // 1. Provider hit its token limit — always retry with a bigger budget.
    if (finishReason === "length") {
      const reason = "Provider stopped at token limit";
      const debugPath = await opts.saveDebug(attempt, rawContent, reason);
      const tokenIssue: ContentQualityIssue = {
        check: "tokenLimit",
        severity: "hard",
        message: reason,
        fixInstruction: TOKEN_LIMIT_FIX_INSTRUCTION,
      };
      validationHistory.push({
        pageRetry: opts.pageRetry ?? 0,
        attempt,
        maxAttempts: max,
        issues: [tokenIssue],
        rawContent,
        debugPath,
        finishReason,
      });
      retryHint = renderValidationHistory(validationHistory);
      candidate.issues = [tokenIssue];
      useExpandedTokens = true;
      bestCandidate = mergeBest(bestCandidate, candidate);
      opts.onDiagnostic?.({
        eventType: "writer_validation_completed",
        pageTitle: opts.title,
        pageRetry,
        attempt,
        maxAttempts: max,
        durationMs: 0,
        bodyChars: candidate.body.length,
        issueCodes: [tokenIssue.check],
        hardIssueCount: 1,
        willRetry: attempt < max,
      });
      if (attempt < max) {
        opts.onWarn?.(
          `Page "${opts.title}" hit provider length limit (attempt ${attempt}/${max}), retrying with expanded budget...`,
        );
        continue;
      }
      throw new PageValidationExhaustedError({
        title: opts.title,
        attempts: max,
        issues: [tokenIssue],
        failedContent: rawContent,
        validationHistory,
      });
    }

    if (loop?.termination === "agent_loop_exhausted") {
      const reason =
        "Writer agent loop exhausted before producing a complete final page";
      const debugPath = await opts.saveDebug(attempt, rawContent, reason);
      const issue: ContentQualityIssue = {
        check: "agentLoopExhausted",
        severity: "hard",
        message: reason,
        fixInstruction:
          "Use targeted repository reads only when necessary, avoid repeated calls, " +
          "then emit the complete page when asked to finalize.",
      };
      validationHistory.push({
        pageRetry,
        attempt,
        maxAttempts: max,
        issues: [issue],
        rawContent,
        debugPath,
        finishReason: "agent_loop_exhausted",
      });
      retryHint = renderValidationHistory(validationHistory);
      candidate.issues = [issue];
      bestCandidate = mergeBest(bestCandidate, candidate);

      opts.onDiagnostic?.({
        eventType: "writer_validation_completed",
        pageTitle: opts.title,
        pageRetry,
        attempt,
        maxAttempts: max,
        durationMs: 0,
        bodyChars: candidate.body.length,
        issueCodes: [issue.check],
        hardIssueCount: 1,
        willRetry: attempt < max,
      });

      if (attempt < max) {
        opts.onWarn?.(
          `Page "${opts.title}" exhausted its agent loop ` +
          `(attempt ${attempt}/${max}), retrying with focused guidance...`,
        );
        continue;
      }

      throw new PageValidationExhaustedError({
        title: opts.title,
        attempts: max,
        issues: [issue],
        failedContent: rawContent,
        validationHistory,
      });
    }

    // Hard server-side gate: rebuild the full page (frontmatter + body) and
    // run the unified validator. Catches MDX parse errors even if the writer
    // never called the `validate_page` tool itself.
    const validationPage = composeForValidation(opts, candidate);
    const validationStartedAt = Date.now();
    const report = await runPageValidation(validationPage, {
      ...(opts.validation ?? {}),
      minBodyLength,
      preserveTitle: opts.preserveTitle,
    });
    const toolIssues = [...report.issues];
    const allIssues = toolIssues.map(toContentQualityIssue);
    candidate.issues = allIssues;
    opts.onDiagnostic?.({
      eventType: "writer_validation_completed",
      pageTitle: opts.title,
      pageRetry,
      attempt,
      maxAttempts: max,
      durationMs: Date.now() - validationStartedAt,
      bodyChars: candidate.body.length,
      issueCodes: allIssues.map((issue) => issue.check),
      hardIssueCount: allIssues.filter((issue) => issue.severity === "hard").length,
      willRetry: allIssues.length > 0 && attempt < max,
    });

    if (allIssues.length === 0) {
      return composeFinal(opts, candidate, attempt, []);
    }

    const hardToolIssues = toolIssues.filter(
      (issue) => issue.severity === "hard",
    );
    const targetedIssue = hardToolIssues.length === 1
      ? classifyTargetedRepairIssue(
          hardToolIssues[0],
          validationPage,
          targetedRepairClasses,
        )
      : null;
    if (targetedIssue && opts.repairMdx) {
      const repairResult = await opts.repairMdx({
        draft: validationPage,
        issue: targetedIssue.issue,
        repairClass: targetedIssue.repairClass,
        writerAttempt: attempt,
        pageRetry,
      });
      for (const repairAttempt of repairResult.attempts) {
        await emitRepairDiagnostic(opts, {
          pageId: opts.pageId ?? opts.title,
          pageTitle: opts.title,
          pageRetry,
          writerAttempt: attempt,
          attempt: repairAttempt.attempt,
          maxAttempts: repairResult.maxAttempts,
          rule: targetedIssue.issue.rule,
          message: targetedIssue.issue.message,
          line: targetedIssue.issue.line,
          column: targetedIssue.issue.col,
          snippet: targetedIssue.issue.snippet,
          draft: validationPage,
          repairKind: "model_patch",
          repairClass: targetedIssue.repairClass,
          repairSucceeded: repairAttempt.accepted,
          rejectionReason: repairAttempt.rejectionReason ?? undefined,
          validationIssueCodes: repairAttempt.validationIssueCodes,
        });
      }
      if (repairResult.ok) {
        return {
          content: repairResult.content,
          attempts: attempt,
          appliedFixes: [],
          warnings: [],
        };
      }

      if (targetedIssue.repairClass === "mdx") {
        const debugPath = await opts.saveDebug(
          attempt,
          validationPage,
          targetedIssue.issue.rule,
        );
        validationHistory.push({
          pageRetry,
          attempt,
          maxAttempts: max,
          issues: allIssues,
          rawContent: validationPage,
          debugPath,
          finishReason,
        });
        throw new PageValidationExhaustedError({
          title: opts.title,
          attempts: repairResult.attempts.length,
          issues: allIssues,
          failedContent: validationPage,
          validationHistory,
        });
      }
    }

    bestCandidate = mergeBest(bestCandidate, candidate);

    const reasonList = allIssues.map((i) => i.check).join(", ");
    const debugPath = await opts.saveDebug(attempt, rawContent, reasonList);
    validationHistory.push({
      pageRetry: opts.pageRetry ?? 0,
      attempt,
      maxAttempts: max,
      issues: allIssues,
      rawContent,
      debugPath,
      finishReason,
    });
    retryHint = renderValidationHistory(validationHistory);

    if (attempt < max) {
      opts.onWarn?.(
        `Page "${opts.title}" content quality issues (attempt ${attempt}/${max}): ${reasonList}, retrying...`,
      );
      continue;
    }
  }

  // Exhausted all attempts — graceful degradation.
  if (!bestCandidate) {
    throw new Error(`Page "${opts.title}" — writer pipeline exited without producing any candidate`);
  }
  return finalizeWithDegradation(opts, bestCandidate, max, validationHistory);
}

// ─── Internals ─────────────────────────────────────────────────────────

/**
 * Run the cleanup transforms on raw model output.
 * Order matters: we unwrap any outer code fence first so commentary
 * stripping operates on the intended body, not on the wrapper preamble.
 */
function cleanRawContent(rawContent: string): AttemptCandidate {
  const cleaned = stripAgentCommentary(unwrapOuterCodeFence(rawContent));

  const fm = parseFrontmatter(cleaned);
  const agentDescription = fm.frontmatter?.description
    ? String(fm.frontmatter.description)
    : null;

  return {
    rawContent,
    body: cleanWriterBody(cleaned),
    agentDescription,
    issues: [],
  };
}

/**
 * The body cleanup every model-written page text gets: frontmatter and
 * residual artifacts removed, fence languages normalized, `<Step title>`
 * blocks rewritten to `<Step>` + `<StepItem>`, and braces escaped for MDX.
 */
export function cleanWriterBody(content: string): string {
  let body = stripAllFrontmatter(content);
  body = cleanBodyArtifacts(body);
  body = normalizeFenceLanguages(body);
  body = normalizeStepBlocks(body);
  return escapeMdxBraces(body);
}

/**
 * Pick the better of two candidates for graceful degradation.
 *  - Fewer hard issues wins.
 *  - Tie? Fewer total issues wins.
 *  - Tie? Longer body wins (more salvageable content).
 */
function mergeBest(
  current: AttemptCandidate | null,
  next: AttemptCandidate,
): AttemptCandidate {
  if (!current) return next;
  const hardCurrent = countSeverity(current.issues, "hard");
  const hardNext = countSeverity(next.issues, "hard");
  if (hardNext !== hardCurrent) return hardNext < hardCurrent ? next : current;
  if (next.issues.length !== current.issues.length) {
    return next.issues.length < current.issues.length ? next : current;
  }
  return next.body.length > current.body.length ? next : current;
}

function countSeverity(
  issues: ContentQualityIssue[],
  severity: "hard" | "soft",
): number {
  return issues.filter((i) => i.severity === severity).length;
}

/**
 * Final-attempt fallback: if the best candidate has only soft issues, run
 * the registered auto-fixes and accept it. Hard issues mean regeneration
 * is the only correct answer — throw.
 */
function finalizeWithDegradation(
  opts: WriterAttemptOptions,
  best: AttemptCandidate,
  max: number,
  validationHistory: readonly ValidationHistoryEntry[],
): WriterAttemptResult {
  const hardIssues = best.issues.filter((i) => i.severity === "hard");
  if (hardIssues.length > 0) {
    const latest = validationHistory.at(-1);
    const latestHardIssues = latest?.issues.filter((issue) => issue.severity === "hard") ?? [];
    throw new PageValidationExhaustedError({
      title: opts.title,
      attempts: max,
      issues: latestHardIssues.length > 0 ? latestHardIssues : hardIssues,
      failedContent: latest?.rawContent ?? best.rawContent,
      validationHistory,
    });
  }

  const { body: patched, applied } = applyAutoFixes(best.body, best.issues);
  const fixedCandidate: AttemptCandidate = { ...best, body: patched };

  if (applied.length > 0) {
    const summary = applied.map((i) => i.check).join(", ");
    opts.onWarn?.(
      `Page "${opts.title}" accepted after ${max} attempts with auto-fixes: ${summary}`,
    );
  }

  return composeFinal(opts, fixedCandidate, max, applied);
}

function cloneValidationHistory(
  history: readonly ValidationHistoryEntry[],
): ValidationHistoryEntry[] {
  return history.map((entry) => ({
    ...entry,
    issues: entry.issues.map((issue) => ({
      ...issue,
      location: issue.location ? { ...issue.location } : undefined,
      fixExample: issue.fixExample ? { ...issue.fixExample } : undefined,
    })),
  }));
}

/**
 * Reconstruct the full page (frontmatter + body) for the validation gate so
 * MDX compile + frontmatter checks run against what the docs-template will
 * actually compile, not just the body.
 */
function composeForValidation(
  opts: WriterAttemptOptions,
  candidate: AttemptCandidate,
): string {
  const description = opts.composeDescription
    ? opts.composeDescription(candidate.agentDescription)
    : candidate.agentDescription || opts.description;
  const frontmatter = buildFrontmatter({
    title: opts.title,
    description,
    apiMethod: opts.apiMethod,
    apiPath: opts.apiPath,
  }, { preserveTitle: opts.preserveTitle });
  return composePage(frontmatter, candidate.body);
}

/**
 * Map the unified {@link ToolValidationIssue} produced by `runPageValidation`
 * back to the legacy {@link ContentQualityIssue} shape consumed by
 * `buildRetryHint` and the rest of the pipeline. Keeps the retry-hint
 * pipeline unchanged while letting the gate emit MDX-parse + frontmatter
 * issues alongside the body detectors.
 */
function toContentQualityIssue(t: ToolValidationIssue): ContentQualityIssue {
  const issue: ContentQualityIssue = {
    check: t.rule,
    severity: t.severity,
    message: t.message,
    fixInstruction: t.hint,
  };
  if (t.line !== undefined && t.snippet !== undefined) {
    issue.location = {
      line: Math.max(0, t.line - 1),
      ...(t.col !== undefined ? { column: t.col } : {}),
      snippet: t.snippet,
    };
  } else if (t.line !== undefined) {
    issue.location = {
      line: Math.max(0, t.line - 1),
      ...(t.col !== undefined ? { column: t.col } : {}),
      snippet: "",
    };
  }
  return issue;
}

async function emitRepairDiagnostic(
  opts: WriterAttemptOptions,
  diagnostic: Parameters<NonNullable<WriterAttemptOptions["onRepairDiagnostic"]>>[0],
): Promise<void> {
  if (!opts.onRepairDiagnostic) return;
  try {
    await opts.onRepairDiagnostic(diagnostic);
  } catch (error) {
    console.error(JSON.stringify({
      service: "doxa-agent",
      eventType: "repair_diagnostic_sink_failed",
      pageId: diagnostic.pageId,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

/**
 * Compose the final page from the accepted attempt. The description comes
 * from the model when it wrote one, and from the planned page otherwise.
 */
function composeFinal(
  opts: WriterAttemptOptions,
  candidate: AttemptCandidate,
  attempts: number,
  appliedFixes: ContentQualityIssue[],
): WriterAttemptResult {
  const description = opts.composeDescription
    ? opts.composeDescription(candidate.agentDescription)
    : candidate.agentDescription || opts.description;

  const content = composeWriterPage({
    title: opts.title,
    description,
    apiMethod: opts.apiMethod,
    apiPath: opts.apiPath,
    preserveTitle: opts.preserveTitle,
  }, candidate.body);

  return {
    content,
    attempts,
    appliedFixes,
    warnings: appliedFixes.map((i) => `auto-fixed: ${i.check} — ${i.message}`),
  };
}

export interface WriterPageMetadata {
  title: string;
  description: string;
  apiMethod?: string;
  apiPath?: string;
  /** Preserve a deterministic REST method-and-path title verbatim. */
  preserveTitle?: boolean;
  /**
   * Adds the title as a `##` heading when the body starts without one. The
   * page title is already the page heading, so a template page whose body
   * opens with its reference block turns this off.
   */
  leadingTitleHeading?: boolean;
}

/**
 * Compose a saved page: canonical frontmatter, body, ensure a heading
 * follows the frontmatter, then run the structural validator one last time
 * to scrub any remaining schema-level issues. Template-rendered pages use
 * this too, so they keep the shape of a model-written page.
 */
export function composeWriterPage(
  metadata: WriterPageMetadata,
  body: string,
): string {
  const frontmatter = buildFrontmatter({
    title: metadata.title,
    description: metadata.description,
    apiMethod: metadata.apiMethod,
    apiPath: metadata.apiPath,
  }, { preserveTitle: metadata.preserveTitle });

  let content = composePage(frontmatter, body);

  const afterFrontmatter = content.replace(/^---[\s\S]*?---\s*/, "");
  if (metadata.leadingTitleHeading !== false && !afterFrontmatter.startsWith("#")) {
    content = content.replace(/(^---[\s\S]*?---\s*)/, `$1## ${metadata.title}\n\n`);
  }

  // Every Doxa writer emits one Markdown style, so a page edited later in the
  // dashboard does not change text the editor did not touch. Formatting keeps
  // the rendered page the same, and it runs before the last validation so the
  // validator checks the text that is saved.
  content = formatMdx(content);

  const validation = validatePage(content, {
    preserveTitle: metadata.preserveTitle,
  });
  if (!validation.valid) {
    const summary = validation.errors
      .filter((error) => error.severity === "error")
      .map((error) => `${error.field}: ${error.message}`)
      .join("; ");
    throw new Error(`Final page validation failed for "${metadata.title}": ${summary}`);
  }

  return validation.cleaned;
}
