import type {
  DocumentationStructure,
  ProjectAnalysis,
  SourceEvidence,
} from "../types";
import {
  flattenStructure,
  stablePageId,
} from "./structure-utils";

export const WRITER_HANDOFF_VERSION = 1 as const;

export interface WriterHandoffSourceEvidence {
  path: string;
  symbols: string[];
  reason: string;
}

export interface WriterHandoffPageBrief {
  pageId: string;
  title: string;
  route: string;
  pageType: string;
  purpose: string;
  requiredTopics: string[];
  sourceEvidence: WriterHandoffSourceEvidence[];
  relatedPageIds: string[];
  exclusions: string[];
}

export interface WriterHandoffManifest {
  schemaVersion: typeof WRITER_HANDOFF_VERSION;
  sourceRevision: string | null;
  project: {
    name: string;
    slug: string;
    audience: string;
    documentationGoal: string;
  };
  shared: {
    terminology: string[];
    factualConstraints: string[];
    editorialConstraints: string[];
    validationConstraints: string[];
  };
  pages: WriterHandoffPageBrief[];
}

export function buildWriterHandoff(input: {
  analysis: ProjectAnalysis;
  structure: DocumentationStructure;
  sourceRevision: string | null;
  project: { name: string; slug: string };
}): WriterHandoffManifest {
  const exclusions = sortedUnique(
    input.analysis.documentationIntent?.internalOnlyPaths ?? [],
  );
  const targets = flattenStructure(input.structure);
  const pageIds = targets.map(stablePageId);

  return {
    schemaVersion: WRITER_HANDOFF_VERSION,
    sourceRevision: input.sourceRevision,
    project: {
      name: input.project.name,
      slug: input.project.slug,
      audience:
        input.analysis.documentationIntent?.audience ??
        "consumer",
      documentationGoal: firstNonEmpty(
        input.analysis.documentationIntent?.primaryUseCase,
        input.analysis.projectDescription,
        input.analysis.summary,
        `Help readers use ${input.project.name}.`,
      ),
    },
    shared: {
      terminology: sortedUnique(
        input.analysis.documentationIntent?.consumerTerminology ?? [],
      ),
      factualConstraints: [
        "Use repository evidence only; do not invent behavior.",
        "Keep examples consistent with accepted public workflows.",
      ],
      editorialConstraints: [
        "Write for the stated audience, not repository contributors.",
        "Preserve the accepted documentation structure.",
      ],
      validationConstraints: [
        "Return a complete MDX page without planning commentary.",
        "Use only canonical generated routes for internal links.",
      ],
    },
    pages: targets.map((target) => {
      const pageId = stablePageId(target);
      const parentPageId = `${target.sectionId}/${target.page.id}`;
      const page = target.page;
      const relatedPageIds = pageIds.filter((candidate) =>
        candidate !== pageId &&
        (candidate === parentPageId || candidate.startsWith(`${parentPageId}/`)),
      );
      return {
        pageId,
        title: page.title,
        route: routeFromOutputPath(target.path),
        pageType: page.reference ? "reference" : "documentation",
        purpose: page.description,
        requiredTopics: [page.description],
        sourceEvidence: (page.sourceEvidence ?? []).map(
          toHandoffEvidence,
        ),
        relatedPageIds,
        exclusions,
      };
    }),
  };
}

export function selectWriterPageBriefs(
  handoff: WriterHandoffManifest,
  pageIds: readonly string[],
): WriterHandoffManifest {
  const briefById = new Map(
    handoff.pages.map((page) => [page.pageId, page]),
  );
  const pages = pageIds.map((pageId) => {
    const brief = briefById.get(pageId);
    if (!brief) {
      throw new Error(`Writer handoff is missing page brief: ${pageId}`);
    }
    return brief;
  });
  return { ...handoff, pages };
}

export function formatWriterHandoffSharedForPrompt(
  handoff: WriterHandoffManifest,
): string {
  return [
    "AUTHORITATIVE PLANNER HANDOFF (SHARED JOB CONTEXT):",
    JSON.stringify({
      project: handoff.project,
      shared: handoff.shared,
    }, null, 2),
  ].join("\n");
}

export function formatWriterHandoffPageForPrompt(
  handoff: WriterHandoffManifest,
  pageId: string,
): string {
  const brief = selectWriterPageBriefs(handoff, [pageId]).pages[0];
  return [
    "AUTHORITATIVE PLANNER PAGE BRIEF:",
    JSON.stringify({ page: brief }, null, 2),
    "",
    "Implement this page brief exactly. Do not redesign navigation, add unsupported claims, or replace the requested page with a different topic.",
  ].join("\n");
}

/** @deprecated Use the shared and page-specific formatters at their prompt layers. */
export function formatWriterHandoffForPrompt(
  handoff: WriterHandoffManifest,
  pageId: string,
): string {
  return [
    formatWriterHandoffSharedForPrompt(handoff),
    formatWriterHandoffPageForPrompt(handoff, pageId),
  ].join("\n\n");
}

function toHandoffEvidence(
  evidence: SourceEvidence,
): WriterHandoffSourceEvidence {
  return {
    path: evidence.path,
    symbols: [],
    reason:
      evidence.title ??
      evidence.kind ??
      "Accepted source evidence for this page",
  };
}

function routeFromOutputPath(path: string): string {
  const normalized = path
    .replace(/^default\//, "")
    .replace(/\/index\.mdx?$/, "")
    .replace(/\.mdx?$/, "");
  return normalized ? `/${normalized}` : "/";
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function firstNonEmpty(
  ...values: Array<string | null | undefined>
): string {
  return values.find((value) => value?.trim())!.trim();
}
