import { z } from "zod";
import { validationIssueSchema } from "@doxahq/contracts/validation";
import { siteConfigSchema } from "./schema/site-config";
import { resolveSiteConfig } from "./resolve";
import { validateInputLimits, SITE_CONFIG_LIMITS } from "./validation/limits";
import { toValidationIssues } from "./validation/zod-issues";
import { dropInvalidNodes } from "./validation/drop-invalid";

const strictParseResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), config: siteConfigSchema }),
  z.object({ ok: z.literal(false), issues: z.array(validationIssueSchema) }),
]);
const lenientParseResultSchema = z.object({
  config: siteConfigSchema,
  droppedPaths: z.array(z.string()),
});
export type StrictParseResult = z.input<typeof strictParseResultSchema>;
export type LenientParseResult = z.output<typeof lenientParseResultSchema>;

export function parseSiteConfigStrict(input: unknown): StrictParseResult {
  const issues = validateInputLimits(input);
  if (issues.length) return { ok: false, issues };
  const result = siteConfigSchema.safeParse(input);
  return result.success
    ? { ok: true, config: result.data }
    : { ok: false, issues: toValidationIssues(result.error, input) };
}

export function parseSiteConfigLenient(input: unknown): LenientParseResult {
  const droppedPaths = new Set<string>();
  try {
    const initial = parseSiteConfigStrict(input);
    if (initial.ok)
      return { config: resolveSiteConfig(initial.config), droppedPaths: [] };
    if (
      initial.issues.some((issue) =>
        ["too_deep", "config_too_large"].includes(issue.code),
      )
    ) {
      return { config: resolveSiteConfig({}), droppedPaths: [""] };
    }
    let candidate: unknown = JSON.parse(JSON.stringify(input));
    for (let pass = 0; pass < SITE_CONFIG_LIMITS.lenientPasses; pass++) {
      const parsed = parseSiteConfigStrict(candidate);
      if (parsed.ok)
        return {
          config: resolveSiteConfig(parsed.config),
          droppedPaths: [...droppedPaths],
        };
      if (parsed.issues.some((issue) => issue.path === "")) {
        candidate = {};
        droppedPaths.add("");
      } else
        for (const path of dropInvalidNodes(candidate, parsed.issues))
          droppedPaths.add(path);
    }
  } catch {
    droppedPaths.add("");
  }
  droppedPaths.add("");
  return { config: resolveSiteConfig({}), droppedPaths: [...droppedPaths] };
}
