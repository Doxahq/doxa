/**
 * validate_page tool — terminal correctness gate for the writer agent.
 *
 * Each writer agent must call this tool with the full page draft (frontmatter
 * + body) before emitting its final output. The tool returns a JSON-encoded
 * {@link ToolValidationReport} from {@link runPageValidation}, which folds in
 * frontmatter validation, body content-quality detectors, and the MDX
 * subprocess parse pass. The same aggregator runs server-side as the hard
 * gate in the writer pipeline — calling this tool simply lets the model
 * self-correct in-loop instead of burning a full retry attempt.
 */

import { z } from "zod/v4";
import { defineTool } from "../tool";
import { runPageValidation } from "../../utils/page-validator";
import type { AgentSpanCallback } from "../types";

export interface ValidatePageToolOptions {
  /** Skip the MDX subprocess parse pass. Default: run it. */
  mdxCompile?: boolean;
  /** Subprocess timeout for the MDX parse pass, in ms. Default 10000. */
  timeoutMs?: number;
  /** Reject body content shorter than this many characters. Default 200. */
  minBodyLength?: number;
  /** Preserve deterministic REST method-and-path titles during validation. */
  preserveTitle?: boolean;
  /** Reject sections that the REST endpoint renderer already provides. */
  restEndpointPage?: boolean;
  /** Receives MDX validation timing spans. */
  onSpan?: AgentSpanCallback;
  /** Exact values that no page may contain, such as the run's credentials. */
  forbiddenValues?: readonly string[];
}

export const VALIDATE_PAGE_TOOL_DESCRIPTION =
  "Validate the current page draft. MUST be called before finishing the page; only emit the final page when this returns ok=true. " +
  "Checks frontmatter schema, structural quality (skeleton/cutoff/empty section/unclosed code fence/unbalanced JSX), MDX parse correctness, and component registration (only components registered in the docs-template can be used). " +
  "Pass the FULL page including the `---` frontmatter block.";

export function validatePageTool(opts: ValidatePageToolOptions = {}) {
  return defineTool({
    name: "validate_page",
    description: VALIDATE_PAGE_TOOL_DESCRIPTION,
    parameters: z.object({
      content: z
        .string()
        .describe("Full MDX page content including the `---` frontmatter block."),
    }),
    execute: async ({ content }) => {
      const report = await runPageValidation(content, {
        mdxCompile: opts.mdxCompile,
        timeoutMs: opts.timeoutMs,
        minBodyLength: opts.minBodyLength,
        preserveTitle: opts.preserveTitle,
        restEndpointPage: opts.restEndpointPage,
        onSpan: opts.onSpan,
        forbiddenValues: opts.forbiddenValues,
      });
      return JSON.stringify(report);
    },
  });
}
