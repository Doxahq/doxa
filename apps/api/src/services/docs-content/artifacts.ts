import {
  createRuntimeSearchDocument,
  normalizeHref,
  parseDocsManifestText,
  runtimeSearchArtifactSchema,
  updateRuntimeSearchDocument,
  type DocsManifest,
} from "@doxahq/docs-engine";

/** One effective page and the source that will be published for it. */
/**
 * One page of a new version. `content` is null for an unchanged page whose
 * body the publish did not read. Such a page keeps its base search entry.
 */
export interface EditedContentPage {
  href: string;
  sourcePath: string;
  content: string | null;
  title: string;
}

/**
 * Reads the `title` field of an MDX frontmatter block.
 *
 * The manifest, the navigation files, and the search index all carry a copy of
 * the page title. When an editor changes the frontmatter, every copy must
 * follow, or navigation and search drift away from the page.
 */
export function readFrontmatterTitle(source: string): string | null {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(source);
  if (!match) return null;

  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    if (line.slice(0, separator).trim() !== "title") continue;

    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^(["'])([\s\S]*)\1$/, "$2")
      .trim();
    return value || null;
  }

  return null;
}

/** Rewrites or adds the frontmatter title without changing the page body. */
export function rewriteFrontmatterTitle(source: string, title: string): string {
  const frontmatter = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(
    source,
  );
  const scalar = frontmatterScalar(title);
  if (!frontmatter) {
    return `---\ntitle: ${scalar}\ndescription: \"\"\n---\n\n${source.replace(/^\s+/, "")}`;
  }

  const metadata = frontmatter[1];
  const titlePattern = /^title\s*:[^\r\n]*$/m;
  const nextMetadata = titlePattern.test(metadata)
    ? metadata.replace(titlePattern, `title: ${scalar}`)
    : `title: ${scalar}\n${metadata}`;
  return source.replace(frontmatter[0], `---\n${nextMetadata}\n---\n`);
}

/**
 * Reads a published manifest. A manifest from a newer artifact schema is
 * treated as unreadable here: the editor must never build a branch on top of
 * content it does not fully understand.
 */
export function parseDocsManifest(raw: string): DocsManifest | null {
  const parsed = parseDocsManifestText(raw);
  return parsed.ok ? parsed.manifest : null;
}

/**
 * Rewrites the manifest for a new version id and any changed page titles.
 *
 * Schema upgrades and their config hash must be complete before this step.
 */
export function applyManifestEdits(
  manifest: DocsManifest,
  input: {
    versionId: string;
    generatedAt: string;
    titlesByHref: ReadonlyMap<string, string>;
  },
): DocsManifest {
  return {
    ...manifest,
    versionId: input.versionId,
    generatedAt: input.generatedAt,
    pages: manifest.pages.map((page) => {
      const title = input.titlesByHref.get(normalizeHref(page.href));
      return title ? { ...page, title } : page;
    }),
  };
}

/**
 * Patches page titles inside a navigation artifact.
 *
 * Navigation files hold headings, spacers, and nested page nodes. Unknown fields
 * are preserved so a navigation shape this version does not model survives the
 * publish untouched. Returns null when nothing changed.
 */
export function applyNavigationTitles(
  raw: string,
  titlesByHref: ReadonlyMap<string, string>,
): string | null {
  const parsed = readJson(raw);
  if (!Array.isArray(parsed)) return null;

  let changed = false;

  const patchNodes = (nodes: readonly unknown[]): unknown[] =>
    nodes.map((node) => {
      if (!isRecord(node)) return node;

      const patched: Record<string, unknown> = { ...node };
      if (Array.isArray(node.items)) {
        patched.items = patchNodes(node.items);
      }
      if (typeof node.href === "string") {
        const title = titlesByHref.get(normalizeHref(node.href));
        if (title && title !== node.title) {
          patched.title = title;
          changed = true;
        }
      }
      return patched;
    });

  const nextNodes = patchNodes(parsed);
  return changed ? toJsonArtifact(nextNodes) : null;
}

/**
 * The normalized hrefs that have an entry in a search index, or null when the
 * index is unreadable.
 */
export function readSearchIndexHrefs(raw: string | null): Set<string> | null {
  const parsed = raw
    ? runtimeSearchArtifactSchema.safeParse(readJson(raw))
    : null;
  return parsed?.success
    ? new Set(parsed.data.documents.map(({ slug }) => normalizeHref(slug)))
    : null;
}

/**
 * Rebuilds the search index from the effective page list.
 *
 * A page with content gets a rebuilt entry. A page without content keeps its
 * existing entry unchanged, so it must have one.
 *
 * Returns null when the artifact is missing or unreadable. The publish then
 * cannot safely replace the existing index.
 */
export function applySearchIndexEdits(
  raw: string,
  input: {
    contentVersion: string;
    pages: readonly EditedContentPage[];
  },
): string | null {
  const parsed = runtimeSearchArtifactSchema.safeParse(readJson(raw));
  if (!parsed.success) return null;

  const documentsBySlug = new Map(
    parsed.data.documents.map(
      (document) => [normalizeHref(document.slug), document] as const,
    ),
  );

  return toJsonArtifact({
    ...parsed.data,
    contentVersion: input.contentVersion,
    documents: input.pages.map((page) => {
      const existing = documentsBySlug.get(normalizeHref(page.href));

      if (page.content === null) {
        if (!existing) {
          throw new Error(`The search index has no entry for ${page.href}.`);
        }
        return existing;
      }

      const pageInput = {
        title: page.title,
        route: page.href,
        content: page.content,
      };
      return existing
        ? updateRuntimeSearchDocument(existing, pageInput)
        : createRuntimeSearchDocument(pageInput);
    }),
  });
}

/** Parses an array-shaped JSON artifact while keeping all unknown node fields. */
export function parseJsonArrayArtifact(raw: string): unknown[] | null {
  const parsed = readJson(raw);
  return Array.isArray(parsed) ? parsed : null;
}

/** One page's place in a section's navigation. */
export interface NavigationPlacement {
  icon: string | null;
  /** The heading that opens this page's group, or null when the page is ungrouped. */
  group: string | null;
  /** Position of the heading in the artifact, or null when the page is ungrouped. */
  groupIndex: number | null;
  /** Position in the section's navigation, so the editor can match the site order. */
  order: number;
}

/** One visible section from `settings/sections.json`. */
export interface DocsNavigationSection {
  slug: string;
  label: string;
  isDefault: boolean;
}

/**
 * Reads every page's placement from one `settings/documents*.json`.
 *
 * A `heading` node opens a group, and the pages after it belong to that group
 * until the next heading. A page before the first heading has no group. Nodes
 * are walked recursively, because a navigation entry can nest pages under
 * `items`, and a nested page inherits the group of its parent.
 *
 * The icon comes from the same walk. The generation agent assigns one icon per
 * page, the docs sidebar draws it, and the editor page list draws it too.
 */
export function readNavigationPlacements(
  raw: string,
): Map<string, NavigationPlacement> {
  const placements = new Map<string, NavigationPlacement>();
  walkNavigation(raw, (entry) => {
    if (entry.kind !== "page") return;
    const existingIcon = placements.get(entry.href)?.icon ?? null;
    placements.set(entry.href, {
      icon: entry.icon ?? existingIcon,
      group: entry.group,
      groupIndex: entry.groupIndex,
      order: entry.order,
    });
  });
  return placements;
}

/** One group heading in a section's navigation. */
export interface NavigationHeading {
  heading: string;
  /** Position of the heading in the artifact, from zero. */
  groupIndex: number;
  /** How many pages come before the heading in the section's navigation. */
  order: number;
}

/**
 * Reads every group heading from one `settings/documents*.json`, in order.
 * The walk is the one `readNavigationPlacements` makes, so the group indexes
 * match. It finds the groups that hold no page yet.
 */
export function readNavigationHeadings(raw: string): NavigationHeading[] {
  const headings: NavigationHeading[] = [];
  walkNavigation(raw, (entry) => {
    if (entry.kind === "heading") {
      headings.push({
        heading: entry.heading,
        groupIndex: entry.groupIndex,
        order: entry.order,
      });
    }
  });
  return headings;
}

type NavigationEntry =
  | { kind: "heading"; heading: string; groupIndex: number; order: number }
  | {
      kind: "page";
      href: string;
      icon: string | null;
      group: string | null;
      groupIndex: number | null;
      order: number;
    };

function walkNavigation(
  raw: string,
  onEntry: (entry: NavigationEntry) => void,
): void {
  const parsed = parseJsonArrayArtifact(raw);
  if (!parsed) return;

  let order = 0;
  let nextGroupIndex = 0;

  const visit = (
    nodes: readonly unknown[],
    inheritedGroup: string | null,
    inheritedGroupIndex: number | null,
  ): void => {
    let group = inheritedGroup;
    let groupIndex = inheritedGroupIndex;

    for (const node of nodes) {
      if (!isRecord(node)) continue;

      if (typeof node.heading === "string" && node.heading.trim()) {
        group = node.heading.trim();
        groupIndex = nextGroupIndex;
        nextGroupIndex += 1;
        onEntry({ kind: "heading", heading: group, groupIndex, order });
        continue;
      }

      if (typeof node.href === "string" && node.href.trim()) {
        onEntry({
          kind: "page",
          href: normalizeHref(node.href),
          icon:
            typeof node.icon === "string" && node.icon.trim()
              ? node.icon
              : null,
          group,
          groupIndex,
          order,
        });
        order += 1;
      }

      if (Array.isArray(node.items)) visit(node.items, group, groupIndex);
    }
  };
  visit(parsed, null, null);
}

/** Reads the ordered visible sections from `settings/sections.json`. */
export function readSections(raw: string): DocsNavigationSection[] {
  const parsed = parseJsonArrayArtifact(raw);
  if (!parsed) return [];

  const sections: DocsNavigationSection[] = [];
  for (const value of parsed) {
    if (!isRecord(value) || value.hidden === true) continue;

    const slug = typeof value.slug === "string" ? value.slug.trim() : "";
    if (!slug) continue;

    const label = typeof value.label === "string" ? value.label.trim() : "";
    sections.push({
      slug,
      label: label || slug,
      isDefault: value.default === true,
    });
  }
  return sections;
}

/** Reads every section slug, including hidden sections that publish still owns. */
export function readSectionSlugs(raw: string): string[] {
  const parsed = parseJsonArrayArtifact(raw);
  if (!parsed) return [];

  const slugs: string[] = [];
  for (const value of parsed) {
    if (!isRecord(value)) continue;
    const slug = typeof value.slug === "string" ? value.slug.trim() : "";
    if (slug && !slugs.includes(slug)) slugs.push(slug);
  }
  return slugs;
}

export function toJsonArtifact(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function frontmatterScalar(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(value)
    ? value
    : JSON.stringify(value);
}
