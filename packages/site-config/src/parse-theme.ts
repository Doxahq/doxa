import { z } from "zod";
import { validationIssueSchema } from "@doxahq/contracts/validation";
import { themeFileSchema } from "./schema/theme";
import { validateInputLimits, SITE_CONFIG_LIMITS } from "./validation/limits";
import { toValidationIssues } from "./validation/zod-issues";
import { createValidationIssue } from "@doxahq/contracts/validation-messages";

const themeParseResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), theme: themeFileSchema }),
  z.object({ ok: z.literal(false), issues: z.array(validationIssueSchema) }),
]);
export type ThemeParseResult = z.output<typeof themeParseResultSchema>;

export function parseThemeFileStrict(input: unknown): ThemeParseResult {
  const issues = validateInputLimits(input, SITE_CONFIG_LIMITS.themeBytes);
  if (issues.length)
    return {
      ok: false,
      issues: [createValidationIssue("invalid_theme_file"), ...issues],
    };
  const parsed = themeFileSchema.safeParse(input);
  return parsed.success
    ? { ok: true, theme: parsed.data }
    : { ok: false, issues: toValidationIssues(parsed.error, input) };
}
