import type { SeedSite } from "@doxahq/contracts";
import { relativeNavigationPathForSection } from "@doxahq/contracts/docs-branches";
import { normalizeHref, parseDocsManifestText } from "@doxahq/docs-engine";

type SeedSection = SeedSite["sections"][number];
type SeedNode = SeedSection["nodes"][number];

/** A hand-written version, as a seeded run reads it. */
export interface LoadedSeedSite {
  site: SeedSite;
  /** The page bodies by route, for the writers. */
  bodies: Record<string, string>;
}

const DEFAULT_SECTION: SeedSection = {
  slug: "default",
  label: "Docs",
  isDefault: true,
  nodes: [],
};

/** One page of a version's manifest. */
export interface SitePageEntry {
  href: string;
  title: string;
  /** The page file inside the version. */
  sourcePath: string;
}

/** The sections, navigation and pages of one version, without page bodies. */
export interface SiteNavigation {
  sections: SeedSection[];
  pages: SitePageEntry[];
}

/**
 * Reads the sections, the navigation and the page list of one version.
 * `versionName` names the version in the error for a missing manifest.
 */
export async function loadSiteNavigation(
  read: (key: string) => Promise<string | null>,
  artifactPrefix: string,
  versionName = "version",
): Promise<SiteNavigation> {
  const navigation = await findSiteNavigation(read, artifactPrefix);
  if (!navigation) throw new Error(`The ${versionName} has no valid manifest.`);
  return navigation;
}

/** The navigation of one version, or null when the version has no valid manifest. */
export async function findSiteNavigation(
  read: (key: string) => Promise<string | null>,
  artifactPrefix: string,
): Promise<SiteNavigation | null> {
  const readFile = (path: string) => read(`${artifactPrefix}/${path}`);
  const manifestText = await readFile("manifest.json");
  const manifest = manifestText ? parseDocsManifestText(manifestText) : null;
  if (!manifest?.ok) return null;

  return {
    sections: await readSections(readFile),
    pages: manifest.manifest.pages.map((page) => ({
      href: normalizeHref(page.href),
      title: page.title,
      sourcePath: page.sourcePath,
    })),
  };
}

/**
 * Reads the navigation, page metadata, and page bodies of one version. The
 * container turns the navigation into the planner's anchor.
 */
export async function loadSeedSite(
  read: (key: string) => Promise<string | null>,
  artifactPrefix: string,
): Promise<LoadedSeedSite> {
  const navigation = await loadSiteNavigation(read, artifactPrefix, "seed version");
  const sections = navigation.sections;
  const pages = await Promise.all(
    navigation.pages.map(async (page) => ({
      href: page.href,
      title: page.title,
      body: await read(`${artifactPrefix}/${page.sourcePath}`),
    })),
  );

  return {
    site: {
      sections,
      pages: pages.map(({ href, title, body }) => {
        const description = body ? frontmatterDescription(body) : null;
        return description ? { href, title, description } : { href, title };
      }),
    },
    bodies: Object.fromEntries(
      pages.flatMap(({ href, body }) => (body === null ? [] : [[href, body]])),
    ),
  };
}

async function readSections(
  readFile: (path: string) => Promise<string | null>,
): Promise<SeedSection[]> {
  const sections = parseArray(await readFile("settings/sections.json"))
    .flatMap((value): SeedSection[] => {
      if (!isRecord(value) || typeof value.slug !== "string") return [];
      return [
        {
          slug: value.slug,
          label: typeof value.label === "string" ? value.label : value.slug,
          isDefault: value.default === true,
          nodes: [],
        },
      ];
    });
  const withDefault = sections.some((section) => section.isDefault)
    ? sections
    : [DEFAULT_SECTION, ...sections];

  return Promise.all(
    withDefault.map(async (section) => ({
      ...section,
      nodes: navigationNodes(
        parseArray(
          await readFile(relativeNavigationPathForSection(section.slug)),
        ),
      ),
    })),
  );
}

/** Headings and pages, with legacy nested items flattened in order. */
function navigationNodes(values: readonly unknown[]): SeedNode[] {
  return values.flatMap((value): SeedNode[] => {
    if (!isRecord(value)) return [];
    const nested = Array.isArray(value.items) ? navigationNodes(value.items) : [];
    if (typeof value.heading === "string" && value.heading.trim()) {
      return [{ heading: value.heading }, ...nested];
    }
    if (typeof value.href === "string" && value.href.startsWith("/")) {
      const title = typeof value.title === "string" ? value.title : "";
      return [{ title, href: normalizeHref(value.href) }, ...nested];
    }
    return nested;
  });
}

/** The `description` of a page's frontmatter, when it has a plain one. */
export function frontmatterDescription(body: string): string | null {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body)?.[1];
  const value = frontmatter
    ? /^description:\s*(.*)$/m.exec(frontmatter)?.[1]?.trim()
    : undefined;
  if (!value) return null;
  return value.replace(/^(["'])(.*)\1$/, "$2").trim() || null;
}

function parseArray(raw: string | null): unknown[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
