import {
  createVersionTreeReader,
  sharedVersionTreeCache,
  type VersionTreeReader,
} from "@doxahq/docs-engine";
import type { Env } from "../../env";
import {
  DocsContentRepository,
  type DocsContentStateStore,
} from "../../repositories/docs-content";
import { createR2SiteAssetStore, type SiteAssetStore } from "../site-assets/store";
import {
  EXPORT_INDEX_PATH,
  EXPORT_MAX_BYTES,
  EXPORT_MAX_FILES,
  SITE_CONFIG_PATH,
  exportFileName,
  exportIndex,
  exportTreeEntries,
  siteAssetHashes,
  siteAssetZipPath,
  type ExportEntry,
  type ExportSiteAssetEntry,
} from "./entries";
import { ExportIntegrityError, createZipStream, type ZipStreamFile } from "./zip-stream";

export interface DocsExportDeps {
  versions: Pick<DocsContentStateStore, "getPublishedVersionForUser">;
  reader: Pick<VersionTreeReader, "readTree" | "get">;
  siteAssets: Pick<SiteAssetStore, "head" | "read">;
  now?: () => Date;
}

export interface DocsExportVersion {
  id: string;
  number: number;
  publishedAt: string;
}

export type DocsExportPlan =
  | { kind: "no_published_version" }
  | { kind: "too_large"; version: DocsExportVersion; sizeBytes: number; fileCount: number }
  | {
      kind: "ready";
      version: DocsExportVersion;
      sizeBytes: number;
      fileCount: number;
      fileName: string;
      /** Builds the stream. Call it at most once. */
      open(hooks: DocsExportStreamHooks): ReadableStream<Uint8Array>;
    };

export interface DocsExportStreamHooks {
  signal?: AbortSignal;
  idleTimeoutMs?: number;
  onComplete?: () => void;
  onError?: (cause: unknown, progress: { bytesSent: number }) => void;
  onCancel?: () => void;
}

/**
 * Builds the zip archive of the published docs of one project.
 *
 * Security: the project comes from the authorized dashboard session, and the
 * site, version and artifact prefix come from the database row of its
 * published version. The client sends no ID, prefix or key. Every read goes
 * through the version tree reader of that prefix, or to the site assets of
 * that site, so an export never reads another site.
 */
export class DocsExportService {
  private readonly now: () => Date;

  constructor(private readonly deps: DocsExportDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  static fromEnv(env: Env): DocsExportService {
    const bucket = env.DOCS_BUCKET;
    return new DocsExportService({
      versions: new DocsContentRepository(env),
      // No blob cache: an export must not push the pages of the dashboard
      // out of the shared byte cache of the process.
      reader: createVersionTreeReader(bucket, { cache: sharedVersionTreeCache(bucket) }),
      siteAssets: createR2SiteAssetStore(bucket),
    });
  }

  async prepare(input: { ownerUserId: string; projectId: string }): Promise<DocsExportPlan> {
    const published = await this.deps.versions.getPublishedVersionForUser({
      userId: input.ownerUserId,
      projectId: input.projectId,
    });
    if (!published) return { kind: "no_published_version" };

    const prefix = published.artifactPrefix;
    const tree = await this.deps.reader.readTree(prefix);
    if (!tree) throw new ExportIntegrityError(prefix, "has no version tree");

    const treeEntries = exportTreeEntries(tree);
    const siteAssets = await this.siteAssetEntries(published.siteId, prefix, tree.files[SITE_CONFIG_PATH] !== undefined);
    const entries: ExportEntry[] = [...treeEntries, ...siteAssets];

    const version: DocsExportVersion = {
      id: published.versionId,
      number: published.versionNumber,
      publishedAt: published.createdAt.toISOString(),
    };
    const sizeBytes = entries.reduce((total, entry) => total + entry.size, 0);
    const fileCount = entries.length + 1;
    if (sizeBytes > EXPORT_MAX_BYTES || fileCount > EXPORT_MAX_FILES) {
      return { kind: "too_large", version, sizeBytes, fileCount };
    }

    const exportedAt = this.now();
    const index = new TextEncoder().encode(
      `${JSON.stringify(
        exportIndex({
          project: { name: published.projectName, slug: published.projectSlug },
          version: { id: published.versionId, number: published.versionNumber, publishedAt: published.createdAt },
          exportedAt,
          entries,
        }),
        null,
        2,
      )}\n`,
    );

    const reader = this.deps.reader;
    const files: ZipStreamFile[] = [
      ...treeEntries.map((entry) => ({
        path: entry.zipPath,
        sha256: entry.sha256,
        size: entry.size,
        read: async () => {
          const object = await reader.get(`${prefix}/${entry.artifactPath}`);
          if (!object) throw new ExportIntegrityError(entry.zipPath, "is missing");
          return new Uint8Array(await object.arrayBuffer());
        },
      })),
      ...siteAssets.map((entry) => ({
        path: entry.zipPath,
        sha256: entry.sha256,
        size: entry.size,
        read: async () => {
          const asset = await this.deps.siteAssets.read(published.siteId, entry.sha256);
          if (!asset) throw new ExportIntegrityError(entry.zipPath, "is missing");
          return new Uint8Array(asset.bytes);
        },
      })),
      { path: EXPORT_INDEX_PATH, sha256: null, size: index.byteLength, read: async () => index },
    ];

    let opened = false;
    return {
      kind: "ready",
      version,
      sizeBytes,
      fileCount,
      fileName: exportFileName(published.projectSlug, exportedAt),
      open: (hooks) => {
        if (opened) throw new Error("A docs export stream opens only once.");
        opened = true;
        return createZipStream({ files, mtime: published.createdAt, ...hooks });
      },
    };
  }

  /** The logo, favicon and social image that the published site config names. */
  private async siteAssetEntries(siteId: string, prefix: string, hasSiteConfig: boolean): Promise<ExportSiteAssetEntry[]> {
    if (!hasSiteConfig) return [];
    const config = await this.deps.reader.get(`${prefix}/${SITE_CONFIG_PATH}`);
    if (!config) throw new ExportIntegrityError(SITE_CONFIG_PATH, "is missing");
    const hashes = siteAssetHashes(await config.text());
    const found = await Promise.all(
      hashes.map(async (sha256) => {
        const head = await this.deps.siteAssets.head(siteId, sha256);
        // An asset that is gone is left out; the site shows no image for it either.
        if (!head) return null;
        const entry: ExportSiteAssetEntry = {
          kind: "site-asset",
          zipPath: siteAssetZipPath(sha256, head.contentType),
          sha256,
          size: head.size,
        };
        return entry;
      }),
    );
    return found.filter((entry): entry is ExportSiteAssetEntry => entry !== null);
  }
}
