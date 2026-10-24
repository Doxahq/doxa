import type { ValidationIssue } from "@doxahq/contracts/validation";
import { parseSiteConfigStrict, resolveSiteConfig } from "@doxahq/site-config";

export class SiteConfigValidationError extends Error {
  constructor(readonly issues: readonly ValidationIssue[]) {
    super(
      `The site settings have ${issues.filter((issue) => issue.severity === "error").length} errors.`,
    );
    this.name = "SiteConfigValidationError";
  }
}

export function validateSiteConfig(input: unknown) {
  const result = parseSiteConfigStrict(input);
  if (!result.ok) throw new SiteConfigValidationError(result.issues);
  return resolveSiteConfig(result.config);
}
