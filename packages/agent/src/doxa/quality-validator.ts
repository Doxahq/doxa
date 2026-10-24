import type { GeneratedPageContent, DocsQualityReport } from "../types";

export function validateGeneratedPages(pages: GeneratedPageContent[]): DocsQualityReport {
  const issues = pages.flatMap((page) => {
    if (page.content.trim().length === 0) {
      return [{
        rule: "empty-page",
        severity: "error" as const,
        title: page.title,
        message: "Generated page is empty.",
      }];
    }
    return [];
  });

  return {
    ok: issues.length === 0,
    issues,
  };
}
