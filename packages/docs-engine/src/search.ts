import {
  runtimeSearchArtifactSchema,
  runtimeSearchDocumentSchema,
  type RuntimeSearchArtifact,
  type RuntimeSearchDocument,
} from "@doxahq/docs-search/contracts";

import type { RuntimeDocsNavigationInput, RuntimeDocsPageInput } from "./index";

export {
  runtimeSearchArtifactSchema,
  runtimeSearchDocumentSchema,
  type RuntimeSearchArtifact,
  type RuntimeSearchDocument,
};

interface ParsedPageContent {
  body: string;
  description: string;
  keywords: string[];
  icon?: string;
}

interface NavigationMetadata {
  title?: string;
  breadcrumb: string[];
  section: string;
  icon?: string;
}

export function createRuntimeSearchArtifact(input: {
  contentVersion: string;
  pages: RuntimeDocsPageInput[];
  navigation?: RuntimeDocsNavigationInput | null;
}): RuntimeSearchArtifact {
  return {
    schemaVersion: 1,
    contentVersion: input.contentVersion,
    documents: input.pages.map((page) =>
      createRuntimeSearchDocument(page, input.navigation),
    ),
  };
}

/**
 * Rebuilds the searchable text of one document after a manual content edit.
 *
 * Navigation-derived fields (breadcrumb, section, icon) are kept from the
 * existing document. The dashboard editor changes page bodies only, and that
 * metadata cannot be recovered from a published artifact, so recomputing it
 * would silently downgrade the search index.
 */
export function updateRuntimeSearchDocument(
  existing: RuntimeSearchDocument,
  page: RuntimeDocsPageInput,
): RuntimeSearchDocument {
  const rebuilt = createRuntimeSearchDocument(page);
  return {
    ...rebuilt,
    id: existing.id,
    slug: existing.slug,
    breadcrumb: existing.breadcrumb,
    section: existing.section,
    ...((existing.icon ?? rebuilt.icon)
      ? { icon: existing.icon ?? rebuilt.icon }
      : {}),
  };
}

/** Builds one search document when no prior index entry exists. */
export function createRuntimeSearchDocument(
  page: RuntimeDocsPageInput,
  navigation?: RuntimeDocsNavigationInput | null,
): RuntimeSearchDocument {
  const parsed = parsePageContent(page.content);
  const navigationMetadata = getNavigationMetadata(page, navigation);
  const slug = normalizeSearchSlug(page.route);
  const lines = extractSearchLines(parsed.body);
  const headings = lines
    .filter((line) => line.anchor !== undefined)
    .map((line) => line.text);

  return {
    id: slug,
    slug,
    title: navigationMetadata.title ?? page.title,
    description: parsed.description,
    breadcrumb: navigationMetadata.breadcrumb,
    ...((navigationMetadata.icon ?? parsed.icon)
      ? { icon: navigationMetadata.icon ?? parsed.icon }
      : {}),
    section: navigationMetadata.section,
    headings,
    keywords: parsed.keywords,
    content: lines.map((line) => line.text).join(" "),
    lines,
  };
}

function parsePageContent(content: string): ParsedPageContent {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/.exec(content);
  if (!match) return { body: content, description: "", keywords: [] };

  const metadata = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    metadata.set(
      line.slice(0, separator).trim(),
      line.slice(separator + 1).trim(),
    );
  }

  const icon = parseScalar(metadata.get("icon"));
  return {
    body: content.slice(match[0].length),
    description: parseScalar(metadata.get("description")) ?? "",
    keywords: parseArray(metadata.get("keywords")),
    ...(icon ? { icon } : {}),
  };
}

function parseScalar(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value
    .replace(
      /^(?:"([\s\S]*)"|'([\s\S]*)')$/,
      (_match, double, single) => double ?? single ?? value,
    )
    .trim();
}

function parseArray(value: string | undefined): string[] {
  if (!value?.startsWith("[") || !value.endsWith("]")) return [];
  return value
    .slice(1, -1)
    .split(",")
    .map((item) => parseScalar(item.trim()) ?? "")
    .filter(Boolean);
}

function getNavigationMetadata(
  page: RuntimeDocsPageInput,
  navigation?: RuntimeDocsNavigationInput | null,
): NavigationMetadata {
  const navigationPath = page.navigationPath?.replace(/^\/+/, "");
  if (!navigation || !navigationPath) {
    return { breadcrumb: [], section: "default" };
  }

  const section = navigation.sections.find(
    (candidate) =>
      candidate.items.includes(navigationPath) ||
      candidate.groups?.some((group) => group.items.includes(navigationPath)),
  );
  const sectionSlug = section?.slug ?? "default";
  const group = section?.groups?.find((candidate) =>
    candidate.items.includes(navigationPath),
  );
  const sectionLabel = navigation.sectionMetadata?.[sectionSlug]?.label;
  const breadcrumb = [
    ...(sectionSlug !== "default" && sectionLabel ? [sectionLabel] : []),
    ...(group?.heading ? [group.heading] : []),
  ];

  return {
    title: navigation.navTitles?.[navigationPath],
    breadcrumb,
    section: sectionSlug,
    icon: navigation.icons?.[navigationPath],
  };
}

function extractSearchLines(body: string): RuntimeSearchDocument["lines"] {
  const lines: RuntimeSearchDocument["lines"] = [];
  let currentAnchor: string | undefined;
  let fenceMarker: string | null = null;

  for (const rawLine of body.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    const fence = /^(`{3,}|~{3,})/.exec(trimmed);
    if (fence) {
      const marker = fence[1][0];
      fenceMarker = fenceMarker === marker ? null : marker;
      continue;
    }
    if (!trimmed || fenceMarker !== null) continue;

    const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (heading) {
      const text = stripMarkdown(heading[2]);
      currentAnchor = heading[1].length >= 2 ? slugifyHeading(text) : undefined;
      lines.push({ text, ...(currentAnchor ? { anchor: currentAnchor } : {}) });
      continue;
    }

    if (/^(?:[-*+]\s|\d+\.\s|\|)/.test(trimmed)) continue;
    const text = stripMarkdown(trimmed);
    if (text.length < 4) continue;
    lines.push({ text, ...(currentAnchor ? { anchor: currentAnchor } : {}) });
  }

  return lines;
}

function stripMarkdown(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/[`*_~>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function slugifyHeading(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function normalizeSearchSlug(route: string): string {
  const normalized = route
    .replace(/\\/g, "/")
    .replace(/\.(?:mdx?|tsx?|jsx?)$/i, "")
    .replace(/\/index$/i, "")
    .replace(/^\/+|\/+$/g, "");
  return normalized ? `/${normalized}` : "/";
}
