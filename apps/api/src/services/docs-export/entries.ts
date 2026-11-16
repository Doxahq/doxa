import type { VersionTree } from "@doxahq/docs-engine";

/**
 * The layout of a docs export archive. Pure functions only: the service reads
 * storage, this module decides names.
 *
 * ```text
 * export.json      format, version, the sha256 of every file
 * doxa.json        settings/site.json (the site configuration)
 * settings/        the other settings files (navigation, features)
 * pages/           source/<slug>/index.mdx as pages/<slug>.mdx
 * assets/          page images
 * site-assets/     logo, favicon and social image, by sha256
 * other/           any other artifact file, under its artifact path
 * ```
 *
 * The search index and the manifest are left out: Doxa builds them again from
 * the pages.
 */

export const EXPORT_FORMAT = "doxa-docs-export";
export const EXPORT_FORMAT_VERSION = 1;
export const EXPORT_INDEX_PATH = "export.json";

/** Zip has no Zip64 in fflate: stay far below 4 GB and 65,535 files. */
export const EXPORT_MAX_BYTES = 1024 * 1024 * 1024;
export const EXPORT_MAX_FILES = 30_000;

const SITE_CONFIG_PATH = "settings/site.json";
const SKIPPED_PATHS = new Set(["manifest.json"]);
const SKIPPED_PREFIXES = ["search/"];
const SITE_ASSET_REF = /"asset:([a-f0-9]{64})"/g;

export interface ExportTreeEntry {
  kind: "artifact";
  /** The path in the archive. */
  zipPath: string;
  /** The artifact path in the version tree. */
  artifactPath: string;
  sha256: string;
  size: number;
}

export interface ExportSiteAssetEntry {
  kind: "site-asset";
  zipPath: string;
  sha256: string;
  size: number;
}

export type ExportEntry = ExportTreeEntry | ExportSiteAssetEntry;

/** Maps every exported file of a version tree to its path in the archive. */
export function exportTreeEntries(tree: VersionTree): ExportTreeEntry[] {
  const entries: ExportTreeEntry[] = [];
  const used = new Set<string>([EXPORT_INDEX_PATH]);
  // Sorted, so the same tree always gives the same archive.
  for (const artifactPath of Object.keys(tree.files).sort()) {
    if (isSkipped(artifactPath)) continue;
    const file = tree.files[artifactPath];
    if (!file) continue;
    let zipPath = archivePath(artifactPath);
    // Two artifact paths must never share one archive path. A clash keeps
    // the artifact path under `other/`, which is unique.
    if (used.has(zipPath)) zipPath = `other/${artifactPath}`;
    used.add(zipPath);
    entries.push({ kind: "artifact", zipPath, artifactPath, sha256: file.sha256, size: file.size });
  }
  return entries;
}

/** The sha256 hashes of the site assets that the site configuration names. */
export function siteAssetHashes(siteConfigText: string): string[] {
  const hashes = new Set<string>();
  for (const match of siteConfigText.matchAll(SITE_ASSET_REF)) {
    if (match[1]) hashes.add(match[1]);
  }
  return [...hashes].sort();
}

export function siteAssetZipPath(sha256: string, contentType: string): string {
  return `site-assets/${sha256}${extensionFor(contentType)}`;
}

/** The file name of the download: `<slug>-docs-<yyyy-mm-dd>.zip`. */
export function exportFileName(projectSlug: string, at: Date): string {
  const slug = projectSlug.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "docs";
  return `${slug}-docs-${at.toISOString().slice(0, 10)}.zip`;
}

export interface ExportIndexInput {
  project: { name: string; slug: string };
  version: { id: string; number: number; publishedAt: Date };
  exportedAt: Date;
  entries: readonly ExportEntry[];
}

/** The contents of `export.json`. */
export function exportIndex(input: ExportIndexInput) {
  return {
    format: EXPORT_FORMAT,
    formatVersion: EXPORT_FORMAT_VERSION,
    exportedAt: input.exportedAt.toISOString(),
    project: { name: input.project.name, slug: input.project.slug },
    version: {
      id: input.version.id,
      number: input.version.number,
      publishedAt: input.version.publishedAt.toISOString(),
    },
    files: input.entries.map((entry) => ({
      path: entry.zipPath,
      ...(entry.kind === "artifact" ? { artifactPath: entry.artifactPath } : {}),
      sha256: entry.sha256,
      size: entry.size,
    })),
  };
}

function isSkipped(path: string): boolean {
  return SKIPPED_PATHS.has(path) || SKIPPED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function archivePath(artifactPath: string): string {
  if (artifactPath === SITE_CONFIG_PATH) return "doxa.json";
  if (artifactPath.startsWith("settings/")) return artifactPath;
  if (artifactPath.startsWith("assets/")) return artifactPath;
  if (artifactPath.startsWith("source/")) {
    const rest = artifactPath.slice("source/".length);
    if (rest === "index.mdx") return "pages/index.mdx";
    if (rest.endsWith("/index.mdx")) return `pages/${rest.slice(0, -"/index.mdx".length)}.mdx`;
    return `pages/${rest}`;
  }
  return `other/${artifactPath}`;
}

/** Re-exported for the service. */
export { SITE_CONFIG_PATH };

const EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/svg+xml": ".svg",
  "image/x-icon": ".ico",
  "image/vnd.microsoft.icon": ".ico",
  "image/avif": ".avif",
};

function extensionFor(contentType: string): string {
  return EXTENSIONS[contentType.split(";")[0]?.trim().toLowerCase() ?? ""] ?? "";
}
