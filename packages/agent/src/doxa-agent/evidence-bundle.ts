import { fileExists, readTextFile } from "../utils/runtime";
import type {
  DocPage,
  PageReferenceMetadata,
  ProjectAnalysis,
  SourceEvidence,
} from "../types";
import {
  ProjectPathAccessError,
  resolveProjectPath,
} from "../core/tools/project-path";
import type { WriterHandoffPageBrief } from "./writer-handoff";
import {
  isMarkdownPath,
  topicSectionExcerpt,
  topicStems,
} from "./evidence-topics";

const DEFAULT_MAX_EVIDENCE_FILE_CHARS = 4_000;
/** About 6k tokens: six files at the per-file cap. */
const DEFAULT_MAX_EVIDENCE_TOTAL_CHARS = 24_000;
/** The page-only context of the default agentic writer keeps its old budget. */
const LEGACY_MAX_EVIDENCE_TOTAL_CHARS = 18_000;
/** Analysis-inferred files the bundle may add after the page's own evidence. */
const MAX_INFERRED_EVIDENCE_FILES = 6;

export interface PageEvidenceBundle {
  pageId: string;
  /** Repo-relative paths actually read into the bundle. */
  paths: string[];
  /** Rendered prompt block, already char-capped. */
  context: string;
  /** True when the bundle is rich enough to skip exploration. */
  sufficient: boolean;
  reason: string;
}

export interface BuildPageEvidenceBundleInput {
  cwd: string;
  pageId?: string;
  page: DocPage;
  analysis: ProjectAnalysis;
  handoffBrief?: WriterHandoffPageBrief;
  maxFileChars?: number;
  maxTotalChars?: number;
}

interface EvidenceCandidate extends SourceEvidence {
  /** Read the file only when some of its Markdown sections match the page topic. */
  requireTopicMatch?: boolean;
}

interface ReadEvidenceResult {
  paths: string[];
  context: string;
  skippedPaths: string[];
}

export async function buildPageEvidenceBundle(
  input: BuildPageEvidenceBundleInput,
): Promise<PageEvidenceBundle> {
  const maxFileChars = positiveLimit(
    input.maxFileChars,
    DEFAULT_MAX_EVIDENCE_FILE_CHARS,
    "maxFileChars",
  );
  const maxTotalChars = positiveLimit(
    input.maxTotalChars,
    DEFAULT_MAX_EVIDENCE_TOTAL_CHARS,
    "maxTotalChars",
  );
  const declared = declaredEvidence(input.page);
  const handoff = (input.handoffBrief?.sourceEvidence ?? []).map(
    (evidence): EvidenceCandidate => ({
      path: evidence.path,
      kind: "other",
      title: evidence.reason,
    }),
  );
  const reference = resolveReferenceEvidence(
    input.analysis,
    input.page.reference,
  );
  const stems = topicStems([
    input.page.title,
    input.page.description,
    ...(input.handoffBrief?.requiredTopics ?? []),
    ...(input.handoffBrief?.sourceEvidence.flatMap((evidence) => evidence.symbols) ?? []),
  ]);
  const inferred = inferredEvidence(input.analysis, input.page, stems);
  const read = await readEvidence({
    cwd: input.cwd,
    evidence: uniqueEvidence([
      ...declared,
      ...handoff,
      ...reference.evidence,
      ...inferred,
    ]),
    stems,
    maxFileChars,
    maxTotalChars,
  });
  const readablePaths = new Set(read.paths);
  const hasRequiredTopics = Boolean(
    input.handoffBrief?.requiredTopics.some((topic) => topic.trim().length > 0),
  );
  const handoffIsBacked = hasRequiredTopics &&
    (input.handoffBrief?.sourceEvidence ?? []).some((evidence) =>
      readablePaths.has(evidence.path)
    );
  const inferredIsBacked = hasRequiredTopics &&
    inferred.some((evidence) => readablePaths.has(evidence.path));
  const sufficient = read.paths.length > 0 &&
    (reference.resolved || handoffIsBacked || inferredIsBacked);

  return {
    pageId: input.pageId ?? input.page.id,
    paths: read.paths,
    context: read.context,
    sufficient,
    reason: bundleReason({
      sufficient,
      readableCount: read.paths.length,
      resolvedReference: reference.resolved,
      handoffIsBacked,
      skippedPaths: read.skippedPaths,
    }),
  };
}

/**
 * Preserve the original page-only evidence context for the default agentic
 * writer. Richer handoff and reference backfill is opt-in through
 * {@link buildPageEvidenceBundle}.
 */
export async function buildSourceEvidenceContext(
  cwd: string,
  page: DocPage,
): Promise<string> {
  const read = await readEvidence({
    cwd,
    evidence: declaredEvidence(page),
    stems: [],
    maxFileChars: DEFAULT_MAX_EVIDENCE_FILE_CHARS,
    maxTotalChars: LEGACY_MAX_EVIDENCE_TOTAL_CHARS,
  });
  return read.context;
}

function declaredEvidence(
  page: DocPage,
): SourceEvidence[] {
  return page.sourceEvidence ?? [];
}

function resolveReferenceEvidence(
  analysis: ProjectAnalysis,
  reference: PageReferenceMetadata | undefined,
): { resolved: boolean; evidence: EvidenceCandidate[] } {
  if (!reference) {
    return { resolved: false, evidence: [] };
  }

  if (reference.kind === "rest") {
    const surface = analysis.referenceSurfaces?.rest;
    const group = surface?.groups.find(
      (candidate) => candidate.id === reference.groupId,
    );
    const endpoint = reference.endpointId
      ? group?.endpoints.find(
          (candidate) => candidate.id === reference.endpointId,
        )
      : undefined;
    const resolved = Boolean(
      group && (!reference.endpointId || endpoint),
    );
    if (!resolved || !surface || !group) {
      return { resolved: false, evidence: [] };
    }
    return {
      resolved: true,
      evidence: uniqueEvidence([
        ...surface.sourceEvidence,
        ...group.sourceEvidence,
        ...(endpoint?.sourceEvidence ?? []),
      ]),
    };
  }

  const surface = analysis.referenceSurfaces?.sdk;
  const module = surface?.modules.find(
    (candidate) => candidate.id === reference.moduleId,
  );
  const sdkExport = reference.exportId
    ? module?.exports.find(
        (candidate) => candidate.id === reference.exportId,
      )
    : undefined;
  const resolved = Boolean(
    module && (!reference.exportId || sdkExport),
  );
  if (!resolved || !surface || !module) {
    return { resolved: false, evidence: [] };
  }
  return {
    resolved: true,
    evidence: uniqueEvidence([
      ...surface.sourceEvidence,
      ...module.sourceEvidence,
      ...(sdkExport?.sourceEvidence ?? []),
    ]),
  };
}

/**
 * Files the analysis ties to the page: the evidence of its collection item,
 * of the canonical workflows that share its topic, and the key Markdown
 * files, read only for their sections on the page topic. Internal-only
 * paths are left out.
 */
function inferredEvidence(
  analysis: ProjectAnalysis,
  page: DocPage,
  stems: readonly string[],
): EvidenceCandidate[] {
  const stemSet = new Set(stems);
  const collectionItem = analysis.documentationCollections
    ?.find((collection) => collection.id === page.collectionId)
    ?.items.find((item) => item.id === page.collectionItemId);
  const intent = analysis.documentationIntent;
  const workflowEvidence = (intent?.canonicalWorkflows ?? [])
    .filter((workflow) =>
      topicStems([workflow.name]).some((stem) => stemSet.has(stem))
    )
    .flatMap((workflow) =>
      workflow.sourceEvidence.map((path): EvidenceCandidate => ({
        path,
        kind: "source",
        title: `${workflow.name} workflow evidence`,
      }))
    );
  const keyDocs = analysis.keyFiles
    .filter(isMarkdownPath)
    .map((path): EvidenceCandidate => ({
      path,
      kind: /(?:^|\/)readme\.[a-z]+$/i.test(path) ? "readme" : "docs",
      requireTopicMatch: true,
    }));
  const internalOnly = intent?.internalOnlyPaths ?? [];

  return uniqueEvidence([
    ...(collectionItem?.sourceEvidence ?? []),
    ...workflowEvidence,
    ...keyDocs,
  ])
    .filter((evidence) =>
      !internalOnly.some((internal) => evidence.path.startsWith(internal))
    )
    .slice(0, MAX_INFERRED_EVIDENCE_FILES);
}

async function readEvidence(input: {
  cwd: string;
  evidence: readonly EvidenceCandidate[];
  /** Page topic stems that pick the sections of a long Markdown file. */
  stems: readonly string[];
  maxFileChars: number;
  maxTotalChars: number;
}): Promise<ReadEvidenceResult> {
  const sections: string[] = [];
  const paths: string[] = [];
  const skippedPaths: string[] = [];
  let remaining = input.maxTotalChars;

  for (const item of uniqueEvidence(input.evidence)) {
    if (remaining <= 0) break;
    try {
      const fullPath = await resolveProjectPath(input.cwd, item.path);
      if (!(await fileExists(fullPath))) {
        skippedPaths.push(item.path);
        continue;
      }
      const raw = sanitizeEvidenceContent(await readTextFile(fullPath));
      const excerpt = evidenceExcerpt(
        item,
        raw,
        input.stems,
        Math.min(input.maxFileChars, remaining),
      );
      if (!excerpt) continue;
      remaining -= excerpt.text.length;
      paths.push(item.path);
      sections.push([
        `### ${item.title || item.path}`,
        `Path: ${item.path}${item.kind ? ` (${item.kind})` : ""}${
          excerpt.sections.length > 0
            ? `; sections: ${excerpt.sections.join(" | ")}`
            : ""
        }`,
        "",
        excerpt.text,
      ].join("\n"));
    } catch (error) {
      if (error instanceof ProjectPathAccessError) throw error;
      skippedPaths.push(item.path);
    }
  }

  return {
    paths,
    context: sections.join("\n\n---\n\n"),
    skippedPaths,
  };
}

/**
 * The part of a file the bundle keeps. A file that fits is kept whole. A
 * longer Markdown file keeps its sections on the page topic, and any other
 * file keeps its start. A file that must match the topic and does not is
 * left out (null).
 */
function evidenceExcerpt(
  item: EvidenceCandidate,
  content: string,
  stems: readonly string[],
  maxChars: number,
): { text: string; sections: string[] } | null {
  const fits = content.length <= maxChars;
  const topical = isMarkdownPath(item.path) && (!fits || item.requireTopicMatch)
    ? topicSectionExcerpt(content, stems, maxChars)
    : null;
  if (item.requireTopicMatch && !topical) return null;
  if (fits) return { text: content, sections: [] };
  return topical ?? { text: content.slice(0, maxChars), sections: [] };
}

function uniqueEvidence<T extends { path: string }>(
  evidence: readonly T[],
): T[] {
  const seen = new Set<string>();
  return evidence.filter((item) => {
    if (!item.path || seen.has(item.path)) return false;
    seen.add(item.path);
    return true;
  });
}

function sanitizeEvidenceContent(content: string): string {
  return content
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith("import ") &&
        !trimmed.startsWith("export ") &&
        !trimmed.startsWith("<img ") &&
        !trimmed.startsWith("</Code") &&
        !trimmed.startsWith("<Code");
    })
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function positiveLimit(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
  return resolved;
}

function bundleReason(input: {
  sufficient: boolean;
  readableCount: number;
  resolvedReference: boolean;
  handoffIsBacked: boolean;
  skippedPaths: readonly string[];
}): string {
  const backing = input.resolvedReference
    ? "a resolved reference surface"
    : input.handoffIsBacked
      ? "a source-backed writer handoff"
      : "analysis evidence on the page topic";
  const status = input.sufficient
    ? `Sufficient evidence: ${input.readableCount} readable file(s) with ${backing}.`
    : input.readableCount === 0
      ? "No readable evidence files were available."
      : "Readable evidence exists, but it has no resolved reference surface, source-backed writer handoff, or analysis evidence on the page topic.";
  if (input.skippedPaths.length === 0) return status;
  return `${status} Skipped missing or unreadable evidence: ${
    input.skippedPaths.join(", ")
  }.`;
}
