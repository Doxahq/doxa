import { z } from "zod";

export const validationIssueCodeSchema = z.enum([
  "invalid_color",
  "invalid_length",
  "unknown_font",
  "invalid_href",
  "unsafe_href_protocol",
  "invalid_asset_ref",
  "too_long",
  "invalid_text",
  "too_many_items",
  "unknown_key",
  "required",
  "invalid_type",
  "unknown_preset",
  "config_too_large",
  "too_deep",
  "link_target_not_found",
  "duplicate_link",
  "entitlement_required",
  "asset_not_found",
  "asset_wrong_kind",
  "asset_unsupported_type",
  "asset_too_large",
  "asset_sanitized",
  "invalid_json",
  "low_contrast",
  "invalid_theme_file",
  "invalid_branch_name",
  "reserved_branch_name",
  "branch_name_taken",
  "branch_limit_reached",
  "too_many_changes",
  "branch_too_large",
  "structure_missing_page",
  "structure_invalid",
  "orphan_page",
  "mdx_invalid",
]);

export const jsonPointerSchema = z.string().regex(/^(?:\/(?:[^~/]|~[01])*)*$/);
export const validationIssueSchema = z
  .object({
    path: jsonPointerSchema,
    code: validationIssueCodeSchema,
    severity: z.enum(["error", "warning"]),
    message: z.string().max(300),
    params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  })
  .strict();

export const validationErrorBodySchema = z
  .object({
    code: z.literal("validation_failed"),
    issues: z.array(validationIssueSchema),
  })
  .strict();

export type ValidationIssue = z.infer<typeof validationIssueSchema>;
export type ValidationIssueCode = z.infer<typeof validationIssueCodeSchema>;
