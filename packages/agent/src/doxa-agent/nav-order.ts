import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { run } from "../core";
import type { AgentUsageCallback, Provider } from "../core";
import type {
  AgentProgressCallback,
  DocumentationGenerationBrief,
  DocumentationStructure,
  GeneratedPageContent,
  ProjectAnalysis,
} from "../types";
import type { DoxabotPageType } from "@doxahq/contracts";
import { sanitizeNavTitle } from "../utils/frontmatter";
import { headingNamesTurnedOffType } from "../utils/planned-page-types";
import { turnedOffPageTypes } from "./project-instructions/stage-guidance";
import {
  chooseFallbackIcon,
  iconCandidates,
  loadIconCatalog,
  resolveIconName,
  type IconCatalog,
} from "../navigation-icons";
import { DEFAULT_SECTION_FOLDER, flattenStructure, sectionFolder, slugify } from "./structure-utils";
import { formatDocHead } from "./prompts/dynamic";
import type { OrderingDocInput, OrderingSectionInput } from "./prompts/dynamic";
import { prompts } from "./prompts";
import type { PromptRegistry } from "./prompts";
import {
  ProjectPathAccessError,
  resolveProjectPath,
} from "../core/tools/project-path";

/**
 * Filename written by the CLI to disk, used as the canonical identifier
 * during the ordering pass and in the persisted manifest.
 */
export const NAV_ORDER_MANIFEST_FILENAME = ".nav-order.json";

export interface NavOrderGroup {
  heading: string;
  items: string[];
}

export interface NavOrderSection {
  slug: string;
  items: string[];
  groups?: NavOrderGroup[];
}

export interface NavOrderSectionMetadata {
  label: string;
  kind?: "documentation" | "reference" | "development";
  layout?: "docs" | "reference";
}

export interface NavOrderManifest {
  sections: NavOrderSection[];
  /** REST endpoint paths intentionally have no icon entry; navBadges supplies the method chip. */
  icons?: Record<string, string>;
  navTitles?: Record<string, string>;
  navBadges?: Record<string, string>;
  sectionMetadata?: Record<string, NavOrderSectionMetadata>;
  iconSchemaHash?: string;
}

/**
 * Build the complete navigation contract directly from the final structure.
 *
 * Hosted staged generation uses this instead of an additional ordering model
 * call. The structure already contains the editorial order, so this pass only
 * adds deterministic presentation metadata.
 */
export async function buildDeterministicNavOrderManifest(
  structure: DocumentationStructure,
  analysis?: ProjectAnalysis,
  documentationBrief?: DocumentationGenerationBrief,
): Promise<NavOrderManifest> {
  const sections = buildOrderingSections(structure);
  const docs = structure.sections.flatMap((section) => {
    const sectionSlug = sectionFolder(section);
    return flattenStructure({ sections: [section] })
      .filter(
        (target) => target.page.navVisibility !== "hidden",
      )
      .map(
        (target): OrderingDocInput => {
          const reference = target.page.reference;
          return {
            section: sectionSlug,
            filename: target.path,
            title: target.page.title,
            head: target.page.description,
            group: target.page.group,
            ...orderingReferenceFields(reference, analysis),
          };
        },
      );
  });
  const visiblePaths = new Set(docs.map((doc) => doc.filename));
  const navBadges = Object.fromEntries(
    Object.entries(buildReferenceBadgeMap(structure)).filter(([path]) =>
      visiblePaths.has(path),
    ),
  );

  return fallbackManifest(
    sections,
    docs,
    await loadIconCatalog(),
    navBadges,
    turnedOffTypesOf(documentationBrief),
  );
}

interface OrderAndPersistNavOptions {
  provider: Provider;
  pages: GeneratedPageContent[];
  structure: DocumentationStructure;
  fullOutputDir: string;
  cwd: string;
  onProgress?: AgentProgressCallback;
  /** Skip the LLM call when an existing manifest already orders every page. */
  skipIfManifestCovers?: boolean;
  promptRegistry?: PromptRegistry;
  abortController?: AbortController;
  analysis?: ProjectAnalysis;
  documentationBrief?: DocumentationGenerationBrief;
  onModelUsage?: AgentUsageCallback;
  modelCallTimeoutMs?: number;
  modelCallMaxDurationMs?: number;
}

/**
 * Run the ordering pass and persist `<outputDir>/.nav-order.json`. Safe to
 * call with any page count — short-circuits when there is nothing to order.
 */
export async function orderAndPersistNav(options: OrderAndPersistNavOptions): Promise<void> {
  const { provider, pages, structure, fullOutputDir, cwd, onProgress, skipIfManifestCovers } = options;
  const promptRegistry = options.promptRegistry ?? prompts;

  const iconCatalog = await loadIconCatalog(cwd);
  const sections = buildOrderingSections(structure);
  const docs = withIconCandidates(
    buildOrderingDocs(pages, fullOutputDir, sections, structure, options.analysis),
    iconCatalog,
  );
  const navBadges = buildReferenceBadgeMap(structure);

  if (docs.length === 0) return;

  // Nothing to reorder if there is a single section with a single page.
  const totalSections = new Set(docs.map((doc) => doc.section)).size;
  if (totalSections === 1 && docs.length === 1) {
    await writeNavOrderManifest(
      fullOutputDir,
      fallbackManifest(sections, docs, iconCatalog, navBadges, turnedOffTypesOf(options.documentationBrief)),
    );
    return;
  }

  if (skipIfManifestCovers) {
    const existing = await readNavOrderManifest(fullOutputDir);
    if (existing && manifestCoversDocs(existing, docs, iconCatalog)) return;
  }

  onProgress?.({
    stage: "ordering",
    message: "Determining documentation order…",
    progress: 90,
  });

  const manifest = await runOrderingWithRetry(
    provider,
    sections,
    docs,
    iconCatalog,
    navBadges,
    { analysis: options.analysis, documentationBrief: options.documentationBrief },
    promptRegistry,
    3,
    options.abortController,
    options.onModelUsage,
    options.modelCallTimeoutMs,
    options.modelCallMaxDurationMs,
  );

  if (!manifest) {
    onProgress?.({
      stage: "ordering",
      message: "Ordering pass failed after retries — keeping input order",
      progress: 95,
    });
    await writeNavOrderManifest(
      fullOutputDir,
      fallbackManifest(sections, docs, iconCatalog, navBadges, turnedOffTypesOf(options.documentationBrief)),
    );
    return;
  }

  await writeNavOrderManifest(fullOutputDir, manifest);
  onProgress?.({
    stage: "ordering",
    message: "Documentation order finalized",
    progress: 98,
  });
}

function buildOrderingSections(structure: DocumentationStructure): OrderingSectionInput[] {
  return structure.sections.map((section) => {
    const slug = sectionFolder(section);
    return {
      slug,
      label: section.title,
      isDefault: Boolean(section.default),
    };
  });
}

function buildOrderingDocs(
  pages: GeneratedPageContent[],
  fullOutputDir: string,
  sections: OrderingSectionInput[],
  structure: DocumentationStructure,
  analysis?: ProjectAnalysis,
): OrderingDocInput[] {
  const knownSlugs = new Set(sections.map((s) => s.slug));
  const referenceByPath = new Map(
    flattenStructure(structure).map((target) => [
      target.path,
      target.page.reference,
    ]),
  );
  return pages
    .map((page) => {
      const filename = relativeDocsPath(page.path, fullOutputDir);
      if (!filename) return null;
      const firstSegment = filename.split("/")[0];
      const section = knownSlugs.has(firstSegment) ? firstSegment : DEFAULT_SECTION_FOLDER;
      return {
        section,
        filename,
        title: page.title,
        head: formatDocHead(page.content, 300),
        ...orderingReferenceFields(referenceByPath.get(filename), analysis),
      } as OrderingDocInput;
    })
    .filter((doc): doc is OrderingDocInput => doc !== null);
}

/**
 * Adds the Lucide icons that best match each page, for the ordering prompt.
 * REST endpoint pages show a method badge instead of an icon, so they get none.
 */
function withIconCandidates(docs: OrderingDocInput[], iconCatalog: IconCatalog): OrderingDocInput[] {
  return docs.map((doc) => {
    if (isRestEndpointReferenceDoc(doc)) return doc;
    const candidates = iconCandidates(iconCatalog, doc);
    return candidates.length > 0 ? { ...doc, iconCandidates: candidates } : doc;
  });
}

function orderingReferenceFields(
  reference: OrderingDocInput["reference"],
  analysis: ProjectAnalysis | undefined,
): Pick<
  OrderingDocInput,
  | "reference"
  | "referenceGroupHeading"
  | "referenceGroupOrder"
  | "referenceItemOrder"
> {
  if (!reference) return {};
  if (
    reference.kind === "rest" &&
    (reference.pageKind === "overview" || reference.pageKind === "auth")
  ) {
    return {
      reference,
      referenceGroupOrder: -1,
      referenceItemOrder: reference.pageKind === "overview" ? 0 : 1,
    };
  }
  if (reference.kind !== "rest" || !reference.groupId) {
    return { reference };
  }

  const groups = analysis?.referenceSurfaces?.rest?.groups ?? [];
  const groupOrder = groups.findIndex((group) => group.id === reference.groupId);
  const group = groupOrder >= 0 ? groups[groupOrder] : undefined;
  const endpointOrder = group?.endpoints.findIndex(
    (endpoint) => endpoint.id === reference.endpointId,
  );
  const itemOrder = reference.pageKind === "group"
    ? 0
    : endpointOrder !== undefined && endpointOrder >= 0
      ? endpointOrder + 1
      : undefined;
  return {
    reference,
    referenceGroupHeading:
      group?.title ?? titleizeReferenceGroupId(reference.groupId),
    ...(groupOrder >= 0 ? { referenceGroupOrder: groupOrder } : {}),
    ...(itemOrder !== undefined
      ? { referenceItemOrder: itemOrder }
      : {}),
  };
}

function titleizeReferenceGroupId(groupId: string): string {
  return groupId
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function buildReferenceBadgeMap(structure: DocumentationStructure): Record<string, string> {
  const entries: Array<[string, string]> = [];
  for (const target of flattenStructure(structure)) {
    const reference = target.page.reference;
    if (!reference) continue;
    const badge = reference.kind === "rest"
      ? reference.method?.toUpperCase()
      : compactSdkExportKind(reference.exportKind);
    if (!badge) continue;
    entries.push([target.path, badge]);
  }
  return Object.fromEntries(entries);
}

function compactSdkExportKind(kind: string | undefined): string {
  switch (kind) {
    case "function":
      return "fn";
    case "class":
      return "class";
    case "type":
    case "interface":
      return "type";
    case "hook":
      return "hook";
    case "component":
      return "cmp";
    case "constant":
      return "const";
    case "module":
      return "mod";
    default:
      return "API";
  }
}

function relativeDocsPath(absolutePath: string, fullOutputDir: string): string | null {
  const normalized = absolutePath.replace(/\\/g, "/");
  const root = fullOutputDir.replace(/\\/g, "/").replace(/\/+$/g, "");
  if (!normalized.startsWith(`${root}/`)) return null;
  return normalized.slice(root.length + 1);
}

async function runOrderingWithRetry(
  provider: Provider,
  sections: OrderingSectionInput[],
  docs: OrderingDocInput[],
  iconCatalog: IconCatalog,
  navBadges: Record<string, string>,
  guidance: Pick<OrderAndPersistNavOptions, "analysis" | "documentationBrief">,
  promptRegistry: PromptRegistry = prompts,
  maxAttempts = 3,
  abortController?: AbortController,
  onUsage?: AgentUsageCallback,
  modelCallTimeoutMs?: number,
  modelCallMaxDurationMs?: number,
): Promise<NavOrderManifest | null> {
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const prompt = promptRegistry.buildOrderingPrompt({
      orderingInput: { sections, docs, iconCatalog: iconCatalog.prompt },
      analysis: guidance.analysis,
      documentationBrief: guidance.documentationBrief,
      retryHint: lastError,
      attempt,
    });

    let parsed: unknown;
    try {
      const result = await run(
        {
          provider,
          systemPrompt: prompt.system,
          responseFormat: "json",
          abortController,
          modelCallTimeoutMs,
          modelCallMaxDurationMs,
          usageContext: { operation: "structure", attempt },
          onUsage,
        },
        prompt.user,
      );
      parsed = JSON.parse(extractJsonObject(result.text));
    } catch (error) {
      abortController?.signal.throwIfAborted();
      lastError = error instanceof Error ? error.message : "Failed to parse ordering response";
      continue;
    }

    const validation = validateOrderingManifest(
      parsed,
      sections,
      docs,
      iconCatalog,
      navBadges,
      turnedOffTypesOf(guidance.documentationBrief),
    );
    if (validation.ok) {
      return validation.manifest;
    }
    lastError = validation.error;
  }

  return null;
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenceMatch ? fenceMatch[1].trim() : trimmed;
  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) return candidate;
  return candidate.slice(firstBrace, lastBrace + 1);
}

function validateOrderingManifest(
  parsed: unknown,
  sections: OrderingSectionInput[],
  docs: OrderingDocInput[],
  iconCatalog: IconCatalog,
  navBadges: Record<string, string>,
  turnedOff: ReadonlySet<DoxabotPageType>,
): { ok: true; manifest: NavOrderManifest } | { ok: false; error: string } {
  if (!parsed || typeof parsed !== "object") return { ok: false, error: "Response was not an object." };
  const sectionsField = (parsed as Record<string, unknown>).sections;
  if (!Array.isArray(sectionsField)) return { ok: false, error: "Missing `sections` array." };

  const expectedSlugs = new Set(sections.map((s) => s.slug));
  const seenSlugs = new Set<string>();
  const expectedFiles = new Set(docs.map((d) => d.filename));
  const seenFiles = new Set<string>();
  const icons: Record<string, string> = {};
  const navTitles: Record<string, string> = {};
  const manifest: NavOrderManifest = {
    sections: [],
    icons,
    navTitles,
    navBadges,
    sectionMetadata: buildSectionMetadata(sections),
    iconSchemaHash: iconCatalog.schemaHash,
  };
  const parsedIcons = getParsedManifestIcons(parsed);
  const parsedNavTitles = getParsedManifestNavTitles(parsed);

  for (const entry of sectionsField) {
    if (!entry || typeof entry !== "object") return { ok: false, error: "Section entry was not an object." };
    const slug = (entry as Record<string, unknown>).slug;
    const record = entry as Record<string, unknown>;
    const items = record.items;
    const groups = record.groups;
    if (typeof slug !== "string") return { ok: false, error: "Section entry missing `slug`." };
    if (!expectedSlugs.has(slug)) return { ok: false, error: `Unknown section slug: ${slug}` };
    if (seenSlugs.has(slug)) return { ok: false, error: `Duplicate section slug: ${slug}` };
    seenSlugs.add(slug);

    const sectionDocs = docs.filter((doc) => doc.section === slug);
    const sectionFiles = new Set(sectionDocs.map((doc) => doc.filename));
    const orderedItems: string[] = [];
    const orderedGroups: NavOrderGroup[] = [];

    if (Array.isArray(groups)) {
      for (const group of groups) {
        if (!group || typeof group !== "object") {
          return { ok: false, error: `Section ${slug} group was not an object.` };
        }
        const heading = (group as Record<string, unknown>).heading;
        const groupItems = (group as Record<string, unknown>).items;
        if (typeof heading !== "string" || heading.trim().length === 0) {
          return { ok: false, error: `Section ${slug} group missing heading.` };
        }
        if (!Array.isArray(groupItems) || groupItems.length === 0) {
          return { ok: false, error: `Section ${slug} group "${heading}" must include at least one item.` };
        }

        const normalizedGroupItems: string[] = [];
        for (const filename of groupItems) {
          if (typeof filename !== "string") return { ok: false, error: "Grouped item was not a string." };
          if (!sectionFiles.has(filename)) return { ok: false, error: `Filename ${filename} does not belong to section ${slug}.` };
          if (seenFiles.has(filename)) return { ok: false, error: `Duplicate filename: ${filename}` };
          seenFiles.add(filename);
          orderedItems.push(filename);
          normalizedGroupItems.push(filename);
          if (!isRestReferenceFilename(filename, docs)) {
            icons[filename] = resolveManifestIcon(parsedIcons, filename, docs, iconCatalog);
          }
          navTitles[filename] = resolveManifestNavTitle(parsedNavTitles, filename, docs);
        }

        orderedGroups.push({
          heading: heading.trim(),
          items: normalizedGroupItems,
        });
      }
    } else if (Array.isArray(items)) {
      for (const filename of items) {
        if (typeof filename !== "string") return { ok: false, error: "Item was not a string." };
        if (!sectionFiles.has(filename)) return { ok: false, error: `Filename ${filename} does not belong to section ${slug}.` };
        if (seenFiles.has(filename)) return { ok: false, error: `Duplicate filename: ${filename}` };
        seenFiles.add(filename);
        orderedItems.push(filename);
        if (!isRestReferenceFilename(filename, docs)) {
          icons[filename] = resolveManifestIcon(parsedIcons, filename, docs, iconCatalog);
        }
        navTitles[filename] = resolveManifestNavTitle(parsedNavTitles, filename, docs);
      }
    } else {
      return { ok: false, error: `Section ${slug} missing groups array.` };
    }

    for (const filename of orderedItems) {
      if (!expectedFiles.has(filename)) return { ok: false, error: `Unknown filename: ${filename}` };
    }

    if (orderedItems.length !== sectionFiles.size) {
      return { ok: false, error: `Section ${slug} did not include every page.` };
    }

    const deterministicGroups = sectionDocs.some(isRestReferenceDoc)
      ? fallbackGroupsForSection(
          sections.find((section) => section.slug === slug) ?? {
            slug,
            label: slug,
            isDefault: false,
          },
          sectionDocs,
          turnedOff,
        )
      : withPermittedHeadings(orderedGroups, sectionLabelOf(sections, slug), turnedOff);
    // A renamed heading can merge two groups and move items, so then the
    // item order follows the groups; otherwise the model's order stays.
    const deterministicItems = sectionDocs.some(isRestReferenceDoc) || deterministicGroups !== orderedGroups
      ? deterministicGroups.flatMap((group) => group.items)
      : orderedItems;
    manifest.sections.push({
      slug,
      items: deterministicItems,
      ...(deterministicGroups.length > 0 ? { groups: deterministicGroups } : {}),
    });
  }

  if (seenSlugs.size !== expectedSlugs.size) return { ok: false, error: "Not every section was ordered." };
  if (seenFiles.size !== expectedFiles.size) return { ok: false, error: "Not every page was ordered." };

  return { ok: true, manifest };
}

function manifestCoversDocs(
  manifest: NavOrderManifest,
  docs: OrderingDocInput[],
  iconCatalog: IconCatalog,
): boolean {
  const inManifest = new Set<string>();
  for (const section of manifest.sections) {
    if (!section.groups?.length) return false;
    for (const filename of section.items) inManifest.add(filename);
  }
  if (inManifest.size !== docs.length) return false;
  for (const doc of docs) {
    if (!inManifest.has(doc.filename)) return false;
  }
  if (manifest.iconSchemaHash !== iconCatalog.schemaHash) return false;
  if (!manifest.icons) return false;
  if (!manifest.navTitles) return false;
  for (const doc of docs) {
    const icon = manifest.icons[doc.filename];
    if (isRestReferenceDoc(doc)) {
      if (icon) return false;
    } else if (resolveIconName(iconCatalog, icon) !== icon) {
      return false;
    }
    // A label can be a whole page title, so its length says nothing about its validity.
    if (!manifest.navTitles[doc.filename]) return false;
  }
  return true;
}

function getParsedManifestIcons(parsed: unknown): Record<string, string> {
  if (!parsed || typeof parsed !== "object") return {};
  const rawIcons = (parsed as Record<string, unknown>).icons;
  if (!rawIcons || typeof rawIcons !== "object" || Array.isArray(rawIcons)) return {};

  const result: Record<string, string> = {};
  for (const [filename, icon] of Object.entries(rawIcons)) {
    if (typeof icon === "string") result[filename] = icon;
  }
  return result;
}

function getParsedManifestNavTitles(parsed: unknown): Record<string, string> {
  if (!parsed || typeof parsed !== "object") return {};
  const rawTitles = (parsed as Record<string, unknown>).navTitles;
  if (!rawTitles || typeof rawTitles !== "object" || Array.isArray(rawTitles)) return {};

  const result: Record<string, string> = {};
  for (const [filename, title] of Object.entries(rawTitles)) {
    if (typeof title === "string") result[filename] = title;
  }
  return result;
}

function resolveManifestIcon(
  parsedIcons: Record<string, string>,
  filename: string,
  docs: OrderingDocInput[],
  iconCatalog: IconCatalog,
): string {
  const candidate = resolveIconName(iconCatalog, parsedIcons[filename]);
  if (candidate) return candidate;

  const doc = docs.find((item) => item.filename === filename);
  if (!doc) return "file";
  return chooseFallbackIcon(iconCatalog, doc);
}

function resolveManifestNavTitle(
  parsedNavTitles: Record<string, string>,
  filename: string,
  docs: OrderingDocInput[],
): string {
  const doc = docs.find((item) => item.filename === filename);
  const pageTitle = pageTitleOf(doc, filename);
  return sanitizeNavTitle(
    parsedNavTitles[filename] ?? pageTitle,
    pageTitle,
    isRestReferenceDoc(doc) ? 5 : 3,
  );
}

/** The title of a page, or the last part of its file name when the page has none. */
function pageTitleOf(doc: OrderingDocInput | undefined, filename: string): string {
  return doc?.title ?? filename.split("/").pop()?.replace(/\.(mdx?|md)$/, "") ?? "Overview";
}

function isRestReferenceFilename(
  filename: string,
  docs: OrderingDocInput[],
): boolean {
  return isRestReferenceDoc(docs.find((doc) => doc.filename === filename));
}

function isRestReferenceDoc(
  doc: OrderingDocInput | undefined,
): doc is OrderingDocInput & {
  reference: NonNullable<OrderingDocInput["reference"]> & { kind: "rest" };
} {
  return doc?.reference?.kind === "rest";
}

function isRestEndpointReferenceDoc(
  doc: OrderingDocInput | undefined,
): boolean {
  return isRestReferenceDoc(doc) && Boolean(doc.reference.endpointId);
}

function fallbackManifest(
  sections: OrderingSectionInput[],
  docs: OrderingDocInput[],
  iconCatalog: IconCatalog,
  navBadges: Record<string, string> = {},
  turnedOff: ReadonlySet<DoxabotPageType> = new Set(),
): NavOrderManifest {
  const byDefaultFirst = [...sections].sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return 0;
  });
  const icons = Object.fromEntries(
    docs.filter((doc) => !isRestEndpointReferenceDoc(doc)).map((doc) => [
      doc.filename,
      chooseFallbackIcon(iconCatalog, doc),
    ]),
  );
  const navTitles = Object.fromEntries(
    docs.map((doc) => [
      doc.filename,
      sanitizeNavTitle(doc.title, pageTitleOf(doc, doc.filename), isRestReferenceDoc(doc) ? 5 : 3),
    ]),
  );
  return {
    sections: byDefaultFirst.map((section) => {
      const sectionDocs = docs.filter((doc) => doc.section === section.slug);
      const groups = fallbackGroupsForSection(section, sectionDocs, turnedOff);
      return {
        slug: section.slug,
        items: groups.flatMap((group) => group.items),
        groups,
      };
    }),
    icons,
    navTitles,
    navBadges,
    sectionMetadata: buildSectionMetadata(sections),
    iconSchemaHash: iconCatalog.schemaHash,
  };
}

function buildSectionMetadata(
  sections: OrderingSectionInput[],
): Record<string, NavOrderSectionMetadata> {
  return Object.fromEntries(sections.map((section) => [
    section.slug,
    {
      label: section.label,
      ...sectionKindAndLayout(section),
    },
  ]));
}

function sectionKindAndLayout(
  section: OrderingSectionInput,
): Pick<NavOrderSectionMetadata, "kind" | "layout"> {
  const key = `${section.slug} ${section.label}`.toLowerCase();
  if (section.isDefault) return { kind: "documentation", layout: "docs" };
  if (/\b(rest|api|sdk|reference|endpoint)s?\b/.test(key)) {
    return { kind: "reference", layout: "reference" };
  }
  if (/\b(development|contributing)\b/.test(key)) {
    return { kind: "development", layout: "docs" };
  }
  return { kind: "documentation", layout: "docs" };
}

function fallbackGroupsForSection(
  section: OrderingSectionInput,
  docs: OrderingDocInput[],
  turnedOff: ReadonlySet<DoxabotPageType>,
): NavOrderGroup[] {
  if (docs.length === 0) return [];

  const groups = new Map<string, string[]>();
  for (const doc of orderReferenceDocs(docs)) {
    const heading = fallbackGroupHeading(section, doc, turnedOff);
    const list = groups.get(heading) ?? [];
    list.push(doc.filename);
    groups.set(heading, list);
  }

  return Array.from(groups.entries()).map(([heading, items]) => ({
    heading,
    items,
  }));
}

/** The page types that the owner turned off, which no fallback group heading names. */
function turnedOffTypesOf(brief: DocumentationGenerationBrief | undefined): ReadonlySet<DoxabotPageType> {
  const instructions = brief?.projectInstructions?.instructions;
  return new Set(instructions ? turnedOffPageTypes(instructions) : []);
}

function fallbackGroupHeading(
  section: OrderingSectionInput,
  doc: OrderingDocInput,
  turnedOff: ReadonlySet<DoxabotPageType>,
): string {
  if (
    doc.reference?.kind === "rest" &&
    (doc.reference.pageKind === "overview" || doc.reference.pageKind === "auth")
  ) {
    return "Start Here";
  }
  if (doc.reference?.kind === "rest" && doc.reference.groupId) {
    return doc.referenceGroupHeading ?? titleizeReferenceGroupId(doc.reference.groupId);
  }
  if (doc.group?.trim()) return permittedHeading(doc.group.trim(), section.label, turnedOff);
  const text = `${doc.title} ${doc.filename}`.toLowerCase();
  if (/(overview|intro|getting-started|quickstart|install|setup)/.test(text)) {
    return "Start Here";
  }
  if (/(config|environment|settings|theme|custom)/.test(text)) {
    return "Configuration";
  }
  if (/(api|reference|route|endpoint|schema|raw|llms|robots|sitemap)/.test(text)) {
    return "Reference";
  }
  if (/(deploy|release|build|production|cloudflare|vercel|docker)/.test(text)) {
    return "Operations";
  }
  if (/(troubleshoot|debug|error|faq)/.test(text) && !turnedOff.has("troubleshooting")) {
    return "Troubleshooting";
  }
  return section.isDefault && !turnedOff.has("guides") ? "Guides" : section.label;
}

/**
 * A group heading that names no page type that the owner turned off. A
 * heading such as "Guides" with guides off takes the section label instead;
 * the pages stay, only their heading changes.
 */
function permittedHeading(heading: string, sectionLabel: string, turnedOff: ReadonlySet<DoxabotPageType>): string {
  return headingNamesTurnedOffType(heading, turnedOff) ? sectionLabel : heading;
}

/**
 * The groups with permitted headings, merged where two now share one, in
 * their order. The same array when no heading names a type that is off, so a
 * run without instructions keeps the model's groups exactly.
 */
function withPermittedHeadings(
  groups: NavOrderGroup[],
  sectionLabel: string,
  turnedOff: ReadonlySet<DoxabotPageType>,
): NavOrderGroup[] {
  if (!groups.some((group) => headingNamesTurnedOffType(group.heading, turnedOff))) return groups;
  const merged = new Map<string, string[]>();
  for (const group of groups) {
    const heading = permittedHeading(group.heading, sectionLabel, turnedOff);
    merged.set(heading, [...(merged.get(heading) ?? []), ...group.items]);
  }
  return Array.from(merged, ([heading, items]) => ({ heading, items }));
}

function sectionLabelOf(sections: readonly OrderingSectionInput[], slug: string): string {
  return sections.find((section) => section.slug === slug)?.label ?? slug;
}

function orderReferenceDocs(docs: OrderingDocInput[]): OrderingDocInput[] {
  return [...docs].sort((left, right) => {
    if (!isRestReferenceDoc(left) || !isRestReferenceDoc(right)) return 0;
    const groupOrder =
      (left.referenceGroupOrder ?? Number.MAX_SAFE_INTEGER) -
      (right.referenceGroupOrder ?? Number.MAX_SAFE_INTEGER);
    if (groupOrder !== 0) return groupOrder;
    return (
      (left.referenceItemOrder ?? Number.MAX_SAFE_INTEGER) -
      (right.referenceItemOrder ?? Number.MAX_SAFE_INTEGER)
    );
  });
}

async function writeNavOrderManifest(
  fullOutputDir: string,
  manifest: NavOrderManifest,
): Promise<void> {
  const target = await resolveProjectPath(
    fullOutputDir,
    NAV_ORDER_MANIFEST_FILENAME,
  );
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
}

/**
 * Apply a persisted nav-order manifest to a list of generated docs. Docs not
 * mentioned in the manifest are kept in their input order at the end of their
 * section group; sections not in the manifest sit after manifest-listed ones.
 * Used by callers that load docs from disk (e.g. the `website` command) so the
 * order chosen during generation flows through to the rendered navigation.
 */
export interface DocLike {
  filename: string;
  icon?: string;
  navTitle?: string;
  navBadge?: string;
}

export function applyNavOrderManifest<T extends DocLike>(
  docs: readonly T[],
  manifest: NavOrderManifest,
): T[] {
  const byFilename = new Map<string, T>();
  for (const doc of docs) byFilename.set(doc.filename, withManifestIcon(doc, manifest));

  const ordered: T[] = [];
  const consumed = new Set<string>();

  for (const section of manifest.sections) {
    for (const filename of section.items) {
      const match = byFilename.get(filename);
      if (match && !consumed.has(filename)) {
        ordered.push(match);
        consumed.add(filename);
      }
    }
  }

  for (const doc of docs) {
    if (!consumed.has(doc.filename)) ordered.push(doc);
  }

  return ordered;
}

function withManifestIcon<T extends DocLike>(doc: T, manifest: NavOrderManifest): T {
  const icon = manifest.icons?.[doc.filename];
  const navTitle = manifest.navTitles?.[doc.filename];
  const navBadge = manifest.navBadges?.[doc.filename];
  if (!icon && !navTitle && !navBadge) return doc;
  return {
    ...doc,
    ...(icon ? { icon } : {}),
    ...(navTitle ? { navTitle } : {}),
    ...(navBadge ? { navBadge } : {}),
  };
}

export async function readNavOrderManifest(
  fullOutputDir: string,
): Promise<NavOrderManifest | null> {
  try {
    const manifestPath = await resolveProjectPath(
      fullOutputDir,
      NAV_ORDER_MANIFEST_FILENAME,
    );
    const raw = await readFile(manifestPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (!Array.isArray((parsed as Record<string, unknown>).sections)) return null;
    return parsed as NavOrderManifest;
  } catch (error) {
    if (error instanceof ProjectPathAccessError) throw error;
    return null;
  }
}
