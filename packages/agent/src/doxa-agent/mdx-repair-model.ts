import { z } from "zod/v4";
import { run } from "../core";
import type {
  AgentSpanCallback,
  AgentUsageCallback,
  Provider,
} from "../core";
import type {
  TargetedRepairClass,
} from "../types";
import type { ToolValidationIssue } from "../utils/page-validator";
import {
  applyMdxRepairPatch,
  lineColumnToOffset,
  sha256,
  validateMdxRepairPatch,
  type LocatedMdxIssue,
  type MdxRepairPatch,
} from "../utils/mdx-repair";

const patchSchema = z.object({
  draftSha256: z.string().regex(/^[0-9a-f]{64}$/),
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().nonnegative(),
  replacement: z.string().max(2_048),
  explanation: z.string().trim().min(1).max(1_000),
}).strict();

export const TARGETED_MDX_REPAIR_MAX_ATTEMPTS = 3;

export interface RequestMdxRepairPatchInput {
  provider: Provider;
  draft: string;
  issue: LocatedMdxIssue;
  repairClass?: TargetedRepairClass;
  pageId: string;
  pageTitle: string;
  pageRetry: number;
  writerAttempt: number;
  abortController?: AbortController;
  modelCallTimeoutMs?: number;
  modelCallMaxDurationMs?: number;
  onUsage?: AgentUsageCallback;
  onSpan?: AgentSpanCallback;
  maxAttempts?: number;
}

export interface ClassifiedTargetedRepairIssue {
  repairClass: TargetedRepairClass;
  issue: ToolValidationIssue & { line: number; col: number };
}

export interface MdxRepairAttemptResult {
  attempt: number;
  accepted: boolean;
  rejectionReason: string | null;
  validationIssueCodes: string[];
}

export type ModelMdxRepairResult =
  | {
      ok: true;
      content: string;
      maxAttempts: number;
      attempts: MdxRepairAttemptResult[];
    }
  | {
      ok: false;
      content: null;
      maxAttempts: number;
      attempts: MdxRepairAttemptResult[];
    };

export interface RepairMdxWithModelInput
  extends Omit<RequestMdxRepairPatchInput, "maxAttempts"> {
  maxAttempts: number;
  validate: (
    content: string,
  ) => Promise<{ ok: boolean; issueCodes: string[] }>;
}

interface PatchAttemptSuccess {
  ok: true;
  patch: MdxRepairPatch;
}

interface PatchAttemptFailure {
  ok: false;
  reason: string;
}

type PatchAttemptResult = PatchAttemptSuccess | PatchAttemptFailure;

export function classifyTargetedRepairIssue(
  issue: ToolValidationIssue | undefined,
  draft: string,
  enabledClasses: readonly TargetedRepairClass[],
): ClassifiedTargetedRepairIssue | null {
  if (!issue || issue.severity !== "hard") return null;

  const repairClass = repairClassForRule(issue);
  if (!repairClass || !enabledClasses.includes(repairClass)) return null;
  const location = repairLocation(issue, draft, repairClass);
  if (!location) return null;

  return {
    repairClass,
    issue: {
      ...issue,
      line: location.line,
      col: location.col,
    },
  };
}

export async function repairMdxWithModel(
  input: RepairMdxWithModelInput,
): Promise<ModelMdxRepairResult> {
  const attempts: MdxRepairAttemptResult[] = [];
  let previousRejection = "";

  for (let attempt = 1; attempt <= input.maxAttempts; attempt++) {
    const patchResult = await requestPatchOnce({
      ...input,
      repairAttempt: attempt,
      maxRepairAttempts: input.maxAttempts,
      previousRejection,
    });
    if (!patchResult.ok) {
      previousRejection = patchResult.reason;
      attempts.push({
        attempt,
        accepted: false,
        rejectionReason: previousRejection,
        validationIssueCodes: [],
      });
      continue;
    }

    const content = applyMdxRepairPatch(input.draft, patchResult.patch);
    const validation = await input.validate(content);
    if (validation.ok) {
      attempts.push({
        attempt,
        accepted: true,
        rejectionReason: null,
        validationIssueCodes: [],
      });
      return { ok: true, content, maxAttempts: input.maxAttempts, attempts };
    }

    previousRejection =
      `patched-page-validation-failed:${validation.issueCodes.join(",")}`;
    attempts.push({
      attempt,
      accepted: false,
      rejectionReason: previousRejection,
      validationIssueCodes: validation.issueCodes,
    });
  }

  return {
    ok: false,
    content: null,
    maxAttempts: input.maxAttempts,
    attempts,
  };
}

async function requestPatchOnce(
  input: RequestMdxRepairPatchInput & {
    repairAttempt: number;
    maxRepairAttempts: number;
    previousRejection: string;
  },
): Promise<PatchAttemptResult> {
  const repairClass = input.repairClass ?? "mdx";
  if (input.issue.line === undefined || input.issue.column === undefined) {
    return { ok: false, reason: "parser-location-missing" };
  }
  const parserOffset = lineColumnToOffset(
    input.draft,
    input.issue.line,
    input.issue.column,
  );
  if (parserOffset === null) {
    return { ok: false, reason: "parser-location-invalid" };
  }
  const draftSha256 = sha256(input.draft);
  const contextStart = Math.max(0, parserOffset - 2_000);
  const contextEnd = Math.min(input.draft.length, parserOffset + 2_000);
  const localContext = input.draft.slice(contextStart, contextEnd);
  const result = await run({
    provider: input.provider,
    systemPrompt:
      targetedRepairSystemPrompt(repairClass) +
      " Return JSON only. " +
      "Never rewrite the page. The patch must stay within 64 characters of " +
      "the parser offset and replace at most 512 source characters.",
    responseFormat: "json",
    maxTokens: 1_500,
    abortController: input.abortController,
    modelCallTimeoutMs: input.modelCallTimeoutMs,
    modelCallMaxDurationMs: input.modelCallMaxDurationMs,
    usageContext: {
      operation: "mdx_repair",
      pageId: input.pageId,
      pageTitle: input.pageTitle,
      pageRetry: input.pageRetry,
      attempt: input.repairAttempt,
    },
    onUsage: input.onUsage,
    onSpan: input.onSpan,
  }, [
    `Targeted repair attempt ${input.repairAttempt}/${input.maxRepairAttempts}`,
    `Draft SHA-256: ${draftSha256}`,
    `Target location: line ${input.issue.line}, column ${input.issue.column}, offset ${parserOffset}`,
    `The local draft window spans absolute offsets [${contextStart}, ${contextEnd}).`,
    `Repair class: ${repairClass}`,
    `Validation rule: ${input.issue.rule}`,
    `Validation message: ${input.issue.message}`,
    input.previousRejection
      ? `Previous patch rejected: ${input.previousRejection}`
      : "",
    "Return: {draftSha256,startOffset,endOffset,replacement,explanation}.",
    "Local draft window:",
    localContext,
  ].filter(Boolean).join("\n\n"));

  try {
    const patch = patchSchema.parse(JSON.parse(stripJsonFence(result.text)));
    const validation = validateMdxRepairPatch({
      draft: input.draft,
      parserOffset,
      patch,
    });
    if (validation.ok) return { ok: true, patch };
    return { ok: false, reason: validation.reason ?? "invalid-patch" };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function repairClassForRule(
  issue: ToolValidationIssue,
): TargetedRepairClass | null {
  if (
    issue.rule === "body" ||
    issue.rule === "body-frontmatter-artifact" ||
    issue.rule === "description" ||
    issue.rule === "frontmatter" ||
    issue.rule.startsWith("frontmatter.")
  ) {
    return "frontmatter";
  }
  if (issue.rule === "tooShort") return "length";
  if (
    issue.rule !== "validator-crashed" &&
    issue.line !== undefined &&
    issue.col !== undefined
  ) {
    return "mdx";
  }
  return null;
}

function repairLocation(
  issue: ToolValidationIssue,
  draft: string,
  repairClass: TargetedRepairClass,
): { line: number; col: number } | null {
  if (issue.line !== undefined) {
    return {
      line: issue.line,
      col: issue.col ?? 1,
    };
  }
  if (repairClass === "frontmatter") {
    return locationForLine(draft, /^---\s*$/m);
  }
  if (repairClass === "length") {
    const lines = draft.split("\n");
    const line = Math.max(1, lines.length);
    return {
      line,
      col: Array.from(lines[line - 1] ?? "").length + 1,
    };
  }
  return null;
}

function locationForLine(
  draft: string,
  pattern: RegExp,
): { line: number; col: number } | null {
  const lines = draft.split("\n");
  const index = lines.findIndex((line) => pattern.test(line));
  return index < 0 ? null : { line: index + 1, col: 1 };
}

function targetedRepairSystemPrompt(
  repairClass: TargetedRepairClass,
): string {
  switch (repairClass) {
    case "frontmatter":
      return "You repair one localized frontmatter or metadata artifact.";
    case "length":
      return "You expand one short page with a localized insertion.";
    case "mdx":
      return "You repair one local MDX syntax error.";
  }
}

function stripJsonFence(value: string): string {
  return value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}
