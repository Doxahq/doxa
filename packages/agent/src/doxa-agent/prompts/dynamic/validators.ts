import type { DocumentationStructure, ProjectAnalysis } from "../../../types";
import { normalizeProjectAnalysis } from "../../../utils/analysis-normalizer";
import {
  collectionsWithPages,
  isInternalScriptTitle,
  isPackageScriptTitle,
  looksLikeScriptTitle,
} from "../../../utils/documentation-collection-policy";
import { hasUnbalancedPunctuation } from "../../../utils/title-validation";
import { detectProjectProfile } from "./profiles";

export interface StructureValidationResult {
  valid: boolean;
  errors: string[];
}

export interface StructureCoverageValidationContext {
  stage?: "generation" | "review";
  inputStructure?: DocumentationStructure;
}

export { isPackageScriptTitle };

/**
 * Topical names that must live as PAGES inside Documentation, never as
 * top-level sections. A top-level section is reserved for a self-contained
 * reference surface (e.g. CLI Reference, API Reference, Development) that a
 * reader would expect as a separate navigation root — not for slicing the
 * main docs by topic.
 */
const TOPICAL_SECTION_DENYLIST = new Set([
  "ai",
  "ai features",
  "ai chat",
  "authoring",
  "customization",
  "content",
  "guides",
  "tutorials",
  "getting started",
  "configuration",
  "deployment",
  "integrations",
  "features",
  "overview",
  "reference",
  "components",
  "theming",
  "setup",
  "quickstart",
  "installation",
  "concepts",
  "core concepts",
  "basics",
  "intro",
  "introduction",
]);

const CONSUMER_INTERNAL_PAGE_PATTERNS = [
  /\barchitecture\b/i,
  /\bpackage map\b/i,
  /\be2e\b/i,
  /\bplaywright\b/i,
  /\binternal tooling\b/i,
  /\bdevelopment setup\b/i,
  /\bcontributing\b/i,
  /\bcontributor\b/i,
];

export function validateDocumentationStructureForProfile(
  structure: DocumentationStructure,
  analysis: ProjectAnalysis,
  coverageContext: StructureCoverageValidationContext = {},
): StructureValidationResult {
  const normalizedAnalysis = normalizeProjectAnalysis(analysis);
  const profile = detectProjectProfile(normalizedAnalysis);
  const defaultAudience = normalizedAnalysis.documentationIntent?.audience ?? "consumer";
  const errors: string[] = [];
  const titles = new Set<string>();
  let scriptLikePages = 0;
  let cliReferencePages = 0;

  validateSectionShape(structure, errors);
  validateCollectionCoverage(structure, normalizedAnalysis, errors, coverageContext);
  validateReferenceSurfaceCoverage(structure, normalizedAnalysis, errors, coverageContext);

  for (const section of structure.sections) {
    if (!section.title.trim()) {
      errors.push("A section has an empty title.");
    }

    const sectionTitle = section.title.toLowerCase();
    const isCliSection = sectionTitle.includes("cli") || sectionTitle.includes("command");

    for (const page of section.pages) {
      const normalizedTitle = normalizeTitle(page.title);
      const titleKey = normalizedTitle.toLowerCase();
      const isReferencePage = Boolean(page.reference) || page.audience === "reference";

      const titleIdentity = pageTitleIdentity(section.id, page, titleKey);
      if (titles.has(titleIdentity)) {
        errors.push(`Duplicate page title: ${page.title}`);
      }
      titles.add(titleIdentity);

      if (!page.description || page.description.trim().length < 40) {
        errors.push(`Page "${page.title}" has a weak or missing description.`);
      }

      if (hasUnbalancedPunctuation(page.title)) {
        errors.push(`Page "${page.title}" has unbalanced punctuation. Use a clean reader-facing title without dangling parentheses or brackets.`);
      }

      const pageAudience = page.audience ?? defaultAudience;
      const inDevelopmentSection = sectionTitle.includes("development") || sectionTitle.includes("contributing");
      if (pageAudience === "consumer" && !inDevelopmentSection && CONSUMER_INTERNAL_PAGE_PATTERNS.some((pattern) => pattern.test(page.title))) {
        errors.push(
          `Page "${page.title}" looks maintainer/internal but is in consumer docs. Move it to Development or rewrite it as a user-facing concept such as "How It Works".`
        );
      }

      if (
        !isReferencePage &&
        looksLikeScriptTitle(titleKey)
      ) {
        scriptLikePages++;
      }

      if (isCliSection && !isReferencePage) {
        cliReferencePages++;
      }
    }
  }

  if (profile.id !== "cli") {
    if (scriptLikePages > 2) {
      errors.push(
        `Structure contains ${scriptLikePages} package-script-like pages for a ${profile.label} project. Package scripts must be grouped into workflow pages, not documented one page each.`
      );
    }

    if (cliReferencePages > 0 && normalizedAnalysis.cliCommands.length === 0) {
      errors.push(
        `Structure includes CLI/command reference pages, but no public CLI commands were detected. Do not document package scripts as CLI commands.`
      );
    }
  }

  if (profile.id === "cli") {
    const publicCommandNames = new Set(normalizedAnalysis.cliCommands.map((command) => command.name.toLowerCase()));
    const unknownCommandPages = structure.sections
      .filter((section) => section.title.toLowerCase().includes("cli") || section.title.toLowerCase().includes("command"))
      .flatMap((section) => section.pages)
      .filter((page) => {
        const title = normalizeTitle(page.title).toLowerCase();
        return isInternalScriptTitle(title) && !publicCommandNames.has(title);
      });

    if (unknownCommandPages.length > 0) {
      errors.push(
        `CLI reference includes internal script pages not present in public cliCommands: ${unknownCommandPages.map((page) => page.title).join(", ")}`
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

function validateReferenceSurfaceCoverage(
  structure: DocumentationStructure,
  analysis: ProjectAnalysis,
  errors: string[],
  coverageContext: StructureCoverageValidationContext,
): void {
  const surfaces = analysis.referenceSurfaces;
  if (!surfaces?.rest && !surfaces?.sdk) return;

  const reviewGuidance = referenceReviewGuidance(
    structure,
    coverageContext.inputStructure,
    analysis,
  );
  if (coverageContext.stage === "review" && reviewGuidance.length > 0) {
    for (const guidance of reviewGuidance) {
      errors.push(guidance);
    }
    return;
  }

  if (surfaces.rest?.groups.length) {
    const section = findReferenceSection(structure, surfaces.rest.slug || "rest-api", surfaces.rest.label || "REST API");
    if (!section) {
      errors.push('Detected public REST API endpoints but no separate "REST API" section exists.');
    } else {
      const expectedEndpointKeys = new Map(
        surfaces.rest.groups.flatMap((group) =>
          group.endpoints.map((endpoint) => [
            restEndpointCoverageKey(group.id, endpoint.id),
            endpoint.id,
          ] as const)
        ),
      );
      const actualEndpointKeys = new Set(
        section.pages.flatMap((page) => [page.reference].flatMap((reference) =>
          reference?.kind === "rest" &&
          reference.groupId &&
          reference.endpointId
            ? [restEndpointCoverageKey(reference.groupId, reference.endpointId)]
            : []
        )),
      );
      for (const [key, id] of expectedEndpointKeys) {
        if (!actualEndpointKeys.has(key)) {
          errors.push(`REST API section is missing endpoint reference page for "${id}".`);
        }
      }
    }
  }

  if (surfaces.sdk?.modules.length) {
    const section = findReferenceSection(structure, surfaces.sdk.slug || "api-reference", surfaces.sdk.label || "API Reference");
    if (!section) {
      errors.push('Detected public SDK exports but no separate "API Reference" section exists.');
    } else {
      const coveredModuleIds = new Set(
        section.pages
          .filter((page) => page.reference?.kind === "sdk")
          .map((page) => page.reference?.moduleId)
          .filter(Boolean),
      );
      const expectedExportIds = new Set(
        surfaces.sdk.modules.flatMap((module) =>
          coveredModuleIds.has(module.id)
            ? []
            : module.exports.map((entry) => entry.id)
        ),
      );
      const actualExportIds = new Set(
        section.pages.map((page) => page.reference?.exportId).filter(Boolean),
      );
      for (const id of expectedExportIds) {
        if (!actualExportIds.has(id)) {
          errors.push(`API Reference section is missing SDK export reference page for "${id}".`);
        }
      }
    }
  }
}

function restEndpointCoverageKey(groupId: string, endpointId: string): string {
  return `${groupId}\u0000${endpointId}`;
}

function findReferenceSection(
  structure: DocumentationStructure,
  slug: string,
  label: string,
): DocumentationStructure["sections"][number] | undefined {
  const normalizedSlug = normalizeComparable(slug);
  const normalizedLabel = normalizeComparable(label);
  return structure.sections.find((section) => {
    if (section.default) return false;
    const key = normalizeComparable(`${section.id} ${section.title}`);
    return key.includes(normalizedSlug) || key.includes(normalizedLabel);
  });
}

function validateCollectionCoverage(
  structure: DocumentationStructure,
  analysis: ProjectAnalysis,
  errors: string[],
  coverageContext: StructureCoverageValidationContext,
): void {
  for (const collection of collectionsWithPages(analysis)) {
    const pages = structure.sections.flatMap((section) => section.pages);
    const collectionPages = pages.filter((page) => page.collectionId === collection.id);
    if (collectionPages.length === 0) {
      const droppedPageId = coverageContext.stage === "review"
        ? collectionPageId(coverageContext.inputStructure, collection.id, collection.title)
        : undefined;
      errors.push(
        droppedPageId
          ? `Issue "keep" for pageId ${droppedPageId} instead of dropping it.`
          : `Detected ${collection.items.length}-item collection "${collection.title}" but no grouped pages represent its items.`
      );
      continue;
    }

    const pageKeys = new Set(collectionPages.map((page) =>
      `${page.collectionItemId ?? ""} ${page.id} ${page.title}`.toLowerCase()
    ));
    const missing = collection.items.filter((item) => {
      const itemKey = `${item.id} ${item.slug} ${item.title}`.toLowerCase();
      return !Array.from(pageKeys).some((pageKey) =>
        pageKey.includes(item.id.toLowerCase()) ||
        pageKey.includes(item.slug.toLowerCase()) ||
        itemKey.includes(pageKey)
      );
    });

    if (missing.length > 0) {
      errors.push(
        `Collection "${collection.title}" is missing grouped pages for: ${missing.slice(0, 8).map((item) => item.title).join(", ")}${missing.length > 8 ? ` (+${missing.length - 8} more)` : ""}.`
      );
    }
  }
}

function collectionPageId(
  structure: DocumentationStructure | undefined,
  collectionId: string,
  collectionTitle: string,
): string | undefined {
  if (!structure) return undefined;

  for (const section of structure.sections) {
    const page = section.pages.find((candidate) => {
      if (candidate.collectionId) return candidate.collectionId === collectionId;
      const key = `${candidate.id} ${candidate.title}`.toLowerCase();
      return key.includes(collectionId.toLowerCase()) || key.includes(collectionTitle.toLowerCase());
    });
    if (page) return `${section.id}/${page.id}`;
  }
  return undefined;
}

function referenceReviewGuidance(
  structure: DocumentationStructure,
  inputStructure: DocumentationStructure | undefined,
  analysis: ProjectAnalysis,
): string[] {
  if (!inputStructure) return [];

  const requiredReferences = new Set([
    ...(analysis.referenceSurfaces?.rest?.groups.flatMap((group) => [
      `rest:${group.id}`,
      ...group.endpoints.map((endpoint) => `rest:${group.id}:${endpoint.id}`),
    ]) ?? []),
    ...(analysis.referenceSurfaces?.sdk?.modules.map((module) => `sdk:${module.id}`) ?? []),
  ]);
  const currentReferences = new Map(
    structure.sections.flatMap((section) => section.pages.flatMap((page) => {
      const key = referenceInventoryKey(page.reference);
      return key ? [[key, section.id] as const] : [];
    })),
  );
  return inputStructure.sections.flatMap((section) => section.pages.flatMap((page) => {
    const key = referenceInventoryKey(page.reference);
    if (!key || !requiredReferences.has(key)) return [];

    const currentSectionId = currentReferences.get(key);
    if (!currentSectionId) {
      return [`Issue "keep" for pageId ${section.id}/${page.id} instead of dropping it.`];
    }
    if (currentSectionId !== section.id) {
      return [`Issue "move" for pageId ${section.id}/${page.id} with targetSectionId ${section.id}.`];
    }
    return [];
  }));
}

function referenceInventoryKey(
  reference: DocumentationStructure["sections"][number]["pages"][number]["reference"],
): string | undefined {
  if (reference?.kind === "rest" && reference.groupId) {
    return reference.endpointId
      ? `rest:${reference.groupId}:${reference.endpointId}`
      : `rest:${reference.groupId}`;
  }
  if (reference?.kind === "sdk" && reference.moduleId) return `sdk:${reference.moduleId}`;
  return undefined;
}

function normalizeTitle(title: string): string {
  return title.trim().replace(/^`|`$/g, "");
}

function pageTitleIdentity(
  sectionId: string,
  page: DocumentationStructure["sections"][number]["pages"][number],
  titleKey: string,
): string {
  if (page.reference?.kind === "rest") {
    return `rest:${sectionId}:${page.reference.groupId ?? "ungrouped"}:${titleKey}`;
  }
  return `editorial:${titleKey}`;
}

function normalizeComparable(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function validateSectionShape(structure: DocumentationStructure, errors: string[]): void {
  const sections = structure.sections;

  if (sections.length === 0) {
    errors.push("Structure must contain at least one section (Documentation).");
    return;
  }

  const first = sections[0];
  if (first) {
    if (first.title.trim() !== "Documentation") {
      errors.push(
        `The first section must be titled exactly "Documentation" (the default user-facing section). Got "${first.title}".`
      );
    }
    if (first.default !== true) {
      errors.push(
        `The first section "Documentation" must have "default": true. Every other section must have "default": false or omit the field.`
      );
    }
  }

  for (let i = 1; i < sections.length; i++) {
    const section = sections[i];
    if (!section) continue;
    const trimmed = section.title.trim();
    const key = trimmed.toLowerCase();

    if (TOPICAL_SECTION_DENYLIST.has(key)) {
      errors.push(
        `Section "${trimmed}" is a topical bucket, not a separate-topic reference surface. Move it into Documentation as a page. Top-level non-Documentation sections are reserved for self-contained reference surfaces (e.g. "CLI Reference", "API Reference", "SDK Reference", "Development", "Plugin Reference") that a reader would expect as a distinct navigation root.`
      );
    }

    if (section.default === true) {
      errors.push(
        `Only the "Documentation" section may have "default": true. Section "${trimmed}" must not be marked default.`
      );
    }
  }

  const defaults = sections.filter((section) => section.default === true);
  if (defaults.length > 1) {
    errors.push(
      `Multiple sections have "default": true (${defaults.map((d) => d.title).join(", ")}). Only "Documentation" may be the default.`
    );
  }
}
