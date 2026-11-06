import type { WriterContext, WriterValidationConfig } from "../types";
import {
  addedPageInstructionBreaks,
  listPageInstructionBreaksOfPage,
  pageInstructionRules,
  type PageInstructionBreak,
  type PageInstructionRules,
} from "../utils/page-instruction-checks";
import { runPageValidation, type RunPageValidationOptions } from "../utils/page-validator";

/** The owner's instructions as a page gate, and every break the page had before a repair. */
export interface SplicedPageInstructions {
  rules: PageInstructionRules;
  originalBreaks: readonly PageInstructionBreak[];
}

/**
 * Section repair never runs on REST endpoint pages (`repairQualitySectionsOf`
 * sends them to the whole-page path), so the page here never holds the
 * generated REST reference block.
 */
export function splicedPageInstructions(
  writerContext: WriterContext | undefined,
  originalPage: string,
): SplicedPageInstructions | undefined {
  const instructions = writerContext?.documentationBrief?.projectInstructions?.instructions;
  if (!instructions) return undefined;
  const rules = pageInstructionRules(instructions);
  return { rules, originalBreaks: listPageInstructionBreaksOfPage(originalPage, rules) };
}

/**
 * The writer page gate for a spliced page: no hard issue may remain, and the
 * repair may not add a break of the owner's instructions. Each break counts:
 * one more use of an avoided term, or a new excluded path in place of a
 * fixed term, rejects the splice.
 */
export async function validateSplicedPage(
  content: string,
  writerValidation: WriterValidationConfig,
  onSpan: RunPageValidationOptions["onSpan"],
  instructions?: SplicedPageInstructions,
): Promise<{ ok: boolean; issueCodes: string[] }> {
  const report = await runPageValidation(content, {
    mdxCompile: writerValidation.mdxCompile,
    forbiddenValues: writerValidation.forbiddenValues,
    timeoutMs: writerValidation.timeoutMs,
    onSpan,
    ...(instructions ? { instructionRules: instructions.rules } : {}),
  });
  const addedBreaks = instructions
    ? addedPageInstructionBreaks(instructions.originalBreaks, listPageInstructionBreaksOfPage(content, instructions.rules))
    : [];
  return {
    ok: report.ok && addedBreaks.length === 0,
    issueCodes: report.issues.map((issue) => issue.rule),
  };
}
