import type { ToolAnnotations } from "@modelcontextprotocol/server";
import { z } from "zod";
import { DocsContentError } from "@doxahq/api/services/docs-content/errors";
import { HintedToolError } from "../errors";
import { AGENT_LIVE_TEXT_MAX_LENGTH } from "@doxahq/contracts/agent-live-activity";

export const READ_ONLY_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  openWorldHint: false,
};

export const projectIdInput = z
  .uuid()
  .describe("The project ID, from list_projects.");

export const branchInput = z
  .union([z.literal("main"), z.uuid()])
  .optional()
  .describe(
    '"main" (the default) or a branch ID from list_branches. "main" reads the live, published site.',
  );

export interface BranchView {
  branch: string;
  options: { published: boolean };
}

/**
 * "main" means the live site to an agent. The user's unpublished main drafts
 * belong to the dashboard, so reads of main never include them.
 */
export function branchView(branch: string | undefined): BranchView {
  const resolved = branch ?? "main";
  return { branch: resolved, options: { published: resolved === "main" } };
}

/** Write tools: write annotations, never destructive, closed world. */
export function writeAnnotations(idempotent: boolean): ToolAnnotations {
  return {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: idempotent,
    openWorldHint: false,
  };
}

// "main" is accepted by the schema so the agent gets a hint, not a schema error.
export const namedBranchInput = z
  .union([z.literal("main"), z.uuid()])
  .describe(
    'A branch ID from create_branch or list_branches. "main" is not accepted.',
  );

export const agentNoteInput = z
  .string()
  .max(AGENT_LIVE_TEXT_MAX_LENGTH)
  .optional()
  .describe(
    "One short sentence for the person who watches this work: what you change and why. It appears in the Doxa dashboard.",
  );

export const expectedRevisionInput = z
  .number()
  .int()
  .nonnegative()
  .optional()
  .describe(
    "The branch revision you last read. The call fails with conflict if the branch changed since.",
  );

/** Agents never write to main: they work on a named branch and publish it. */
export function requireNamedBranch(branch: string): string {
  if (branch !== "main") return branch;
  throw new HintedToolError(
    new DocsContentError(
      "invalid",
      "Agents cannot change main directly. Work on a named branch.",
    ),
    "Call create_branch first, then pass its ID as branch.",
  );
}

export const MAX_PAGE_SIZE = 100;
const MAX_OFFSET = 1_000_000;

export const cursorInput = z
  .string()
  .regex(/^\d{1,7}$/)
  .optional()
  .describe("The nextCursor of the previous page. Omit it for the first page.");

export function pageSizeInput(defaultSize: number, maxSize = MAX_PAGE_SIZE) {
  return z.number().int().min(1).max(maxSize).default(defaultSize);
}

export const nextCursorOutput = z.string().nullable();

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Offset pagination over a list that the service returns whole. */
export function pageOf<T>(
  items: readonly T[],
  cursor: string | undefined,
  limit: number,
): Page<T> {
  const offset = Math.min(cursor ? Number(cursor) : 0, MAX_OFFSET);
  const end = offset + limit;
  return {
    items: items.slice(offset, end),
    nextCursor: end < items.length ? String(end) : null,
  };
}
