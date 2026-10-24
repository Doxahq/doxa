import {
  docsContentCreateGroupEditSchema,
  docsContentEditSchema,
} from "@doxahq/contracts";
import type { ValidationIssue } from "@doxahq/contracts/validation";
import { z } from "zod";
import { checkMdxSource } from "@doxahq/api/services/docs-content/mdx-check";
import { MdxInvalidError } from "../../errors";

type EditOption = (typeof docsContentEditSchema.options)[number];
type ExcludedEditOption = Extract<
  EditOption,
  {
    shape: {
      type:
        | z.ZodLiteral<"set_site_config">
        | z.ZodLiteral<"reset_site_config">
        | z.ZodLiteral<"set_home_page">
        | z.ZodLiteral<"create_group">;
    };
  }
>;
type ContentEditOption = Exclude<EditOption, ExcludedEditOption>;

// Site settings (the home page too) have their own tool with merge patches
// and a separate scope.
// `create_group` is swapped for a copy without the dashboard's starter page,
// so a new group starts empty or takes its first page from a later edit.
const EXCLUDED_EDIT_TYPES: ReadonlySet<string> = new Set([
  "set_site_config",
  "reset_site_config",
  "set_home_page",
  "create_group",
]);

function isContentEditOption(
  option: EditOption,
): option is ContentEditOption {
  return !EXCLUDED_EDIT_TYPES.has(option.shape.type.value);
}

const agentCreateGroupEditSchema = docsContentCreateGroupEditSchema.omit({
  starterPage: true,
});

/**
 * The `docsContentEditSchema` union without the site settings edits, and with
 * a `create_group` that adds no placeholder page.
 */
export const contentEditSchema = z.discriminatedUnion("type", [
  agentCreateGroupEditSchema,
  ...docsContentEditSchema.options.filter(isContentEditOption),
]);

export type ContentEdit = z.infer<typeof contentEditSchema>;

/** Runs the renderer's MDX parser on one page source (spec 10.6). */
export function pageSourceIssues(
  content: string,
  path: string,
): ValidationIssue[] {
  return checkMdxSource(content).map((issue) => ({ ...issue, path }));
}

export function contentEditIssues(
  edits: readonly ContentEdit[],
): ValidationIssue[] {
  return edits.flatMap((edit, index) =>
    edit.type === "set_page_content"
      ? pageSourceIssues(edit.content, `/edits/${index}/content`)
      : [],
  );
}

/** Nothing is written when any page source fails the check. */
export function assertNoMdxIssues(issues: readonly ValidationIssue[]): void {
  if (issues.length > 0) throw new MdxInvalidError(issues);
}
