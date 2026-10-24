import type {
  ContainerArtifactFile,
  RuntimeDocsNavigation,
} from "@doxahq/contracts";
import { parseDocsManifestText } from "@doxahq/docs-engine";

export interface ArtifactLinkWarning {
  page: string;
  route: string;
}

/**
 * Finds absolute internal page links that are absent from final navigation.
 *
 * Artifact shape validation remains the caller's responsibility. Link
 * findings are warnings so generation can publish while retaining evidence
 * of route drift.
 */
export function validateArtifactLinks(
  files: readonly ContainerArtifactFile[],
  navigation: RuntimeDocsNavigation,
): ArtifactLinkWarning[] {
  const manifestFile = files.find((file) => file.path === "manifest.json");
  if (!manifestFile) return [];

  const manifest = parseDocsManifestText(manifestFile.content);
  if (!manifest.ok) return [];

  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const navigationRoutes = routesFromNavigation(navigation);
  const warnings = new Map<string, ArtifactLinkWarning>();

  for (const page of manifest.manifest.pages) {
    const source = filesByPath.get(page.sourcePath);
    if (!source) continue;

    for (const route of internalLinkRoutes(source.content)) {
      if (navigationRoutes.has(route)) continue;
      const warning = { page: page.href, route };
      warnings.set(`${warning.page}\0${warning.route}`, warning);
    }
  }

  return [...warnings.values()];
}

function routesFromNavigation(
  navigation: RuntimeDocsNavigation,
): ReadonlySet<string> {
  const routes = new Set<string>();
  for (const section of navigation.sections) {
    for (const item of section.items) {
      routes.add(routeFromNavigationItem(section.slug, item));
    }
  }
  return routes;
}

function routeFromNavigationItem(sectionSlug: string, item: string): string {
  let path = item
    .replaceAll("\\", "/")
    .replace(/^\/+/, "")
    .replace(/\.(?:md|mdx)$/i, "");
  const sectionPrefix = `${sectionSlug}/`;

  if (sectionSlug === "default") {
    path = path.startsWith(sectionPrefix)
      ? path.slice(sectionPrefix.length)
      : path;
  } else if (!path.startsWith(sectionPrefix)) {
    path = `${sectionPrefix}${path}`;
  }

  return normalizeRoute(`/${path}`);
}

function internalLinkRoutes(content: string): string[] {
  const destinations: string[] = [];
  const markdownLink = /(?<!!)\[[^\]]*]\(\s*<?([^)\s>]+)>?(?:\s+["'][^)]*["'])?\s*\)/g;
  const mdxHref =
    /\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|\{\s*"([^"]+)"\s*}|\{\s*'([^']+)'\s*})/g;

  for (const match of content.matchAll(markdownLink)) {
    destinations.push(match[1] ?? "");
  }
  for (const match of content.matchAll(mdxHref)) {
    destinations.push(match[1] ?? match[2] ?? match[3] ?? match[4] ?? "");
  }

  return destinations
    .filter((destination) =>
      destination.startsWith("/") && !destination.startsWith("//")
    )
    .map(normalizeRoute);
}

/**
 * A route as the renderer resolves it: no fragment, query or trailing
 * slash, and `/section/index` is the same page as `/section`.
 */
function normalizeRoute(destination: string): string {
  const [withoutFragment] = destination.split("#", 1);
  const [withoutQuery] = (withoutFragment ?? destination).split("?", 1);
  const normalized = (withoutQuery ?? destination)
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "")
    .replace(/\/index$/i, "");
  return normalized || "/";
}
