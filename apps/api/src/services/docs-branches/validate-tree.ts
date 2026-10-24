import { normalizeHref, sourcePathForHref } from "@doxahq/docs-engine";
import {
  createValidationIssue,
  parseSiteConfigStrict,
  type ValidationIssue,
} from "@doxahq/site-config";
import { contentStructureFromArtifacts } from "../docs-content/structure";
import {
  readNavigationPlacements,
  toJsonArtifact,
} from "../docs-content/artifacts";
import type { EffectiveTree } from "./effective-tree";

/** Checks a merged tree before it becomes a branch base or a live version. */
export async function validateTree(
  tree: EffectiveTree,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  let content;
  try {
    content = await tree.content();
    contentStructureFromArtifacts(
      content.manifest,
      content.navigation.sectionsArtifact,
      content.navigation.documentsBySection,
    );
  } catch {
    return [
      createValidationIssue("structure_invalid", "/settings/sections.json"),
    ];
  }

  const navigationHrefs = new Set<string>();
  const missingHrefs = new Set<string>();

  for (const nodes of content.navigation.documentsBySection.values()) {
    const placements = readNavigationPlacements(toJsonArtifact(nodes));

    for (const href of placements.keys()) {
      navigationHrefs.add(normalizeHref(href));
    }
  }

  const manifestHrefs = new Set(
    content.manifest.pages.map((page) => normalizeHref(page.href)),
  );
  const manifestPaths = new Set(
    content.manifest.pages.map(
      (page) => page.sourcePath || sourcePathForHref(page.href),
    ),
  );
  for (const page of content.manifest.pages) {
    const href = normalizeHref(page.href);
    const path = page.sourcePath || sourcePathForHref(href);

    if (!(await tree.exists(path))) {
      issues.push(
        createValidationIssue("structure_missing_page", `/manifest.json`, {
          href,
        }),
      );
      missingHrefs.add(href);
    }

    if (!navigationHrefs.has(href)) {
      issues.push(
        createValidationIssue(
          "orphan_page",
          `/manifest.json`,
          { href },
          "warning",
        ),
      );
    }
  }

  for (const href of navigationHrefs) {
    if (
      !missingHrefs.has(href) &&
      (!manifestHrefs.has(href) ||
        !(await tree.exists(sourcePathForHref(href))))
    ) {
      issues.push(
        createValidationIssue(
          "structure_missing_page",
          "/settings/sections.json",
          { href },
        ),
      );
    }
  }

  for (const path of await tree.listEffectiveSourcePaths()) {
    if (!path.endsWith("/index.mdx") && path !== "source/index.mdx") {
      continue;
    }

    if (manifestPaths.has(path)) {
      continue;
    }

    const href =
      path === "source/index.mdx"
        ? "/"
        : `/${path.slice("source/".length, -"/index.mdx".length)}`;
    issues.push(
      createValidationIssue(
        "orphan_page",
        "/manifest.json",
        { href },
        "warning",
      ),
    );
  }

  const siteConfigRaw = await tree.read("settings/site.json");

  if (siteConfigRaw !== null) {
    let input: unknown;

    try {
      input = JSON.parse(siteConfigRaw);
    } catch {
      issues.push(createValidationIssue("invalid_json", "/settings/site.json"));
      return issues;
    }

    const config = parseSiteConfigStrict(input);

    if (!config.ok) {
      issues.push(
        ...config.issues.map((issue) => ({
          ...issue,
          path: `/settings/site.json${issue.path}`,
        })),
      );
    }
  }

  return issues;
}
