import type { ValidationIssue } from "@doxahq/contracts/validation";
import type { ResolvedSiteConfig } from "../schema/site-config";
import { createValidationIssue } from "@doxahq/contracts/validation-messages";

function inspectLinks(
  links: readonly { href: string }[],
  path: string,
  pages: ReadonlySet<string>,
): ValidationIssue[] {
  const seen = new Set<string>();
  return links.flatMap((link, index) => {
    const issues: ValidationIssue[] = [];
    const pointer = `${path}/${index}/href`;
    if (seen.has(link.href))
      issues.push(
        createValidationIssue("duplicate_link", pointer, undefined, "warning"),
      );
    seen.add(link.href);
    if (link.href.startsWith("/") && !pages.has(link.href)) {
      issues.push(
        createValidationIssue(
          "link_target_not_found",
          pointer,
          undefined,
          "warning",
        ),
      );
    }
    return issues;
  });
}

export function validateSiteConfigLinks(
  config: ResolvedSiteConfig,
  pageHrefs: readonly string[],
): ValidationIssue[] {
  const pages = new Set(pageHrefs);
  const issues = inspectLinks(config.navbar.links, "/navbar/links", pages);
  config.footer.groups.forEach((group, index) => {
    issues.push(
      ...inspectLinks(group.links, `/footer/groups/${index}/links`, pages),
    );
  });
  if (
    config.navbar.cta?.href.startsWith("/") &&
    !pages.has(config.navbar.cta.href)
  ) {
    issues.push(
      createValidationIssue(
        "link_target_not_found",
        "/navbar/cta/href",
        undefined,
        "warning",
      ),
    );
  }
  return issues;
}
