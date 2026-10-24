import type { DocPage, DocSection, DocumentationStructure, SourceEvidence } from "../types";

export const DEFAULT_SECTION_FOLDER = "default";

export interface RouteRegistryEntry {
  pageId: string;
  title: string;
  sectionTitle: string;
  route: string;
  outputPath: string;
  aliases: string[];
}

export interface RouteRegistry {
  entries: RouteRegistryEntry[];
  routeSet: Set<string>;
  aliasToRoute: Map<string, string>;
}

interface RouteTarget {
  section: DocSection;
  page: DocPage;
}

export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function normalizeRoute(route: string): string {
  const [path, suffix = ""] = splitRouteSuffix(route);
  const normalizedPath = path.replace(/\/+/g, "/").replace(/\/$/, "");
  const resolvedPath = normalizedPath.length > 0 ? normalizedPath : "/";
  return `${resolvedPath}${suffix}`;
}

export function routeFromOutputPath(outputPath: string): string {
  const withoutExt = outputPath.replace(/\.(md|mdx)$/, "");
  if (withoutExt === DEFAULT_SECTION_FOLDER) return "/";
  if (withoutExt.startsWith(`${DEFAULT_SECTION_FOLDER}/`)) {
    return normalizeRoute(`/${withoutExt.slice(DEFAULT_SECTION_FOLDER.length + 1)}`);
  }
  return normalizeRoute(`/${withoutExt}`);
}

export function sectionFolder(section: DocSection): string {
  if (section.default) return DEFAULT_SECTION_FOLDER;
  return slugPath(section.id || section.title);
}

export function pageOutputPath(section: DocSection, page: DocPage): string {
  const canonicalRoute = page.canonicalRoute;
  if (canonicalRoute) return outputPathFromRoute(canonicalRoute, section.default);

  const folder = sectionFolder(section);
  const pageSegment = slugPath(page.id || page.title);
  return `${folder}/${pageSegment}.md`;
}

export function buildRouteRegistry(structure: DocumentationStructure): RouteRegistry {
  const entries: RouteRegistryEntry[] = [];
  const aliasToRoute = new Map<string, string>();

  for (const section of structure.sections) {
    for (const page of section.pages) {
      const pageEntry = buildEntry({ section, page });
      entries.push(pageEntry);
      addAliases(aliasToRoute, pageEntry.route, pageEntry.aliases);

    }
  }

  return {
    entries,
    routeSet: new Set(entries.map((entry) => entry.route)),
    aliasToRoute,
  };
}

export function routeRegistrySummary(registry: RouteRegistry): string {
  return registry.entries
    .map((entry) => {
      const aliases = entry.aliases.length ? ` aliases: ${entry.aliases.join(", ")}` : "";
      return `- ${entry.title}: ${entry.route}${aliases}`;
    })
    .join("\n");
}

export function rewriteInternalLinks(content: string, registry: RouteRegistry): string {
  const rewriteTarget = (target: string): string => {
    const [path, suffix] = splitRouteSuffix(target);
    const route = normalizeRoute(path);
    const mapped = registry.aliasToRoute.get(route);
    if (!mapped || mapped === route) return target;
    return `${mapped}${suffix}`;
  };

  return content
    .replace(/(\]\()(\/[^)\s]+)(\))/g, (_match, prefix: string, target: string, suffix: string) =>
      `${prefix}${rewriteTarget(target)}${suffix}`
    )
    .replace(/(href=["'])(\/[^"']+)(["'])/g, (_match, prefix: string, target: string, suffix: string) =>
      `${prefix}${rewriteTarget(target)}${suffix}`
    );
}

export function closestGeneratedRoutes(route: string, registry: RouteRegistry, limit = 3): string[] {
  const comparable = comparableRoute(route);
  return registry.entries
    .map((entry) => ({
      route: entry.route,
      score: routeSimilarity(comparable, comparableRoute(entry.route)),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.route.localeCompare(b.route))
    .slice(0, limit)
    .map((candidate) => candidate.route);
}

function buildEntry(target: RouteTarget): RouteRegistryEntry {
  const { section, page } = target;
  const title = page.title;
  const outputPath = pageOutputPath(section, page);
  const route = routeFromOutputPath(outputPath);
  const pageId = page.id;
  const aliases = collectAliases(section, page, route);

  return {
    pageId,
    title,
    sectionTitle: section.title,
    route,
    outputPath,
    aliases,
  };
}

function collectAliases(section: DocSection, page: DocPage, route: string): string[] {
  const aliases = new Set<string>();
  const groupPath = page.group ? `/${slugify(page.group)}` : "";
  const legacyTitlePath = `${legacySectionPrefix(section)}${groupPath}/${slugify(page.title)}`;
  addAlias(aliases, legacyTitlePath, route);

  const canonicalRoute = page.canonicalRoute;
  if (canonicalRoute) addAlias(aliases, canonicalRoute, route);

  for (const evidence of evidenceForTarget(page)) {
    for (const sourceRoute of sourceRoutesFromEvidence(evidence)) {
      addAlias(aliases, sourceRoute, route);
    }
  }

  return Array.from(aliases).sort();
}

function evidenceForTarget(page: DocPage): SourceEvidence[] {
  return page.sourceEvidence ?? [];
}

function sourceRoutesFromEvidence(evidence: SourceEvidence): string[] {
  const path = evidence.path.replace(/\\/g, "/");
  const routes = new Set<string>();
  const withExtension = /\.(md|mdx)$/i.test(path);
  if (!withExtension && !path.includes("/")) return [];

  const candidates = [
    path.match(/(?:^|\/)docs\/pages\/(.+)$/)?.[1],
    path.match(/(?:^|\/)src\/contents\/docs\/(.+)$/)?.[1],
    path.match(/(?:^|\/)docs\/(.+)$/)?.[1],
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    const route = routeFromSourcePath(candidate);
    if (route) routes.add(route);
  }

  return Array.from(routes);
}

function routeFromSourcePath(sourcePath: string): string | null {
  const withoutExt = sourcePath.replace(/\.(md|mdx)$/i, "");
  const parts = withoutExt.split("/").filter(Boolean);
  if (parts.at(-1)?.toLowerCase() === "index" || parts.at(-1)?.toLowerCase() === "readme") {
    parts.pop();
  }
  if (parts.length === 0) return "/";
  return normalizeRoute(`/${parts.map(slugPath).join("/")}`);
}

function outputPathFromRoute(route: string, defaultSection?: boolean): string {
  const normalized = normalizeRoute(route);
  const path = normalized === "/" ? "" : normalized.replace(/^\//, "");
  const prefixed = defaultSection ? `${DEFAULT_SECTION_FOLDER}/${path}` : path;
  return `${prefixed || DEFAULT_SECTION_FOLDER}.md`;
}

function addAliases(aliasToRoute: Map<string, string>, route: string, aliases: string[]): void {
  for (const alias of aliases) {
    if (alias !== route) aliasToRoute.set(alias, route);
  }
}

function addAlias(aliases: Set<string>, candidate: string, route: string): void {
  const normalized = normalizeRoute(candidate);
  if (normalized !== route) aliases.add(normalized);
}

function legacySectionPrefix(section: DocSection): string {
  return section.default ? "" : `/${slugify(section.title)}`;
}

function slugPath(value: string): string {
  const segments = value.split("/").map((segment) => slugify(segment)).filter(Boolean);
  return segments.join("/") || "untitled";
}

function splitRouteSuffix(route: string): [string, string] {
  const suffixIndex = route.search(/[?#]/);
  if (suffixIndex === -1) return [route, ""];
  return [route.slice(0, suffixIndex), route.slice(suffixIndex)];
}

function comparableRoute(route: string): string {
  return normalizeRoute(route).replace(/^\//, "");
}

function routeSimilarity(a: string, b: string): number {
  const aParts = new Set(a.split("/").flatMap((part) => part.split("-")).filter(Boolean));
  const bParts = new Set(b.split("/").flatMap((part) => part.split("-")).filter(Boolean));
  let score = 0;
  for (const part of aParts) {
    if (bParts.has(part)) score++;
  }
  if (a.endsWith(b) || b.endsWith(a)) score += 2;
  return score;
}
