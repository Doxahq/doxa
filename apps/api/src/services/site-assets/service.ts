import { sha256Schema } from "@doxahq/contracts/docs-prerender";
import type { SiteAssetUploadResponse } from "@doxahq/contracts/site-assets";
import {
  assetRefSchema,
  createValidationIssue,
  type SiteAssetKind,
} from "@doxahq/site-config";
import type { Env } from "../../env";
import { ProjectsRepository } from "../../repositories/projects";
import { DocsContentError } from "../docs-content/errors";
import type { StorageLimitsService } from "../entitlements";
import { planSeamsFromEnv } from "../billing/plan-seams";
import { SiteConfigValidationError } from "../site-config-validation";
import { prepareSiteAssetIsolated, type PreparedSiteAsset } from "./content";
import {
  compressUploadedImage,
  type ImageCompressionProfile,
  type ImageCompressor,
} from "./image-compression";
import type { SvgCleaner } from "./image-content";
import { createR2SiteAssetStore, type SiteAssetStore } from "./store";

export interface OwnedSiteLookup {
  getDocsSiteForUser(
    userId: string,
    projectId: string,
  ): Promise<{ siteId: string } | null>;
  /**
   * Runs `work` while no other upload of the site runs, so a usage check and
   * the write that it allows act as one step.
   */
  withSiteAssetLock<T>(siteId: string, work: () => Promise<T>): Promise<T>;
}

export interface SiteAssetsDeps {
  sites: OwnedSiteLookup;
  store: SiteAssetStore;
  storageLimits: StorageLimitsService;
  compressor?: ImageCompressor | null;
  svgCleaner?: SvgCleaner | null;
}

/** A favicon is small, and not every browser reads every format for one. */
const COMPRESSION_PROFILES: Record<SiteAssetKind, ImageCompressionProfile | null> = {
  logo: "logo",
  ogImage: "og_image",
  favicon: null,
};

export class SiteAssetsService {
  constructor(private readonly deps: SiteAssetsDeps) {}

  static fromEnv(env: Env): SiteAssetsService {
    return new SiteAssetsService({
      sites: new ProjectsRepository(env),
      store: createR2SiteAssetStore(env.DOCS_BUCKET),
      storageLimits: planSeamsFromEnv(env).storageLimits,
      compressor: env.IMAGE_COMPRESSOR ?? null,
      svgCleaner: env.SVG_CLEANER ?? null,
    });
  }

  private async resolveSite(userId: string, projectId: string) {
    const site = await this.deps.sites.getDocsSiteForUser(userId, projectId);
    if (!site) throw new DocsContentError("not_found", "Project not found.");
    return site;
  }

  async upload(
    userId: string,
    projectId: string,
    kind: SiteAssetKind,
    input: Uint8Array,
  ): Promise<SiteAssetUploadResponse> {
    const { siteId } = await this.resolveSite(userId, projectId);
    return this.store(projectId, siteId, kind, input);
  }

  /**
   * Stores an image that a generation found for the site branding. The
   * caller resolved the site from the job, so no user check applies here.
   */
  uploadForGeneration(
    projectId: string,
    siteId: string,
    kind: SiteAssetKind,
    input: Uint8Array,
  ): Promise<SiteAssetUploadResponse> {
    return this.store(projectId, siteId, kind, input);
  }

  private async store(
    projectId: string,
    siteId: string,
    kind: SiteAssetKind,
    input: Uint8Array,
  ): Promise<SiteAssetUploadResponse> {
    const asset = await this.compress(
      await prepareSiteAssetIsolated(input, kind, this.deps.svgCleaner),
      kind,
    );
    const digest = await crypto.subtle.digest(
      "SHA-256",
      Uint8Array.from(asset.bytes),
    );
    const hash = [...new Uint8Array(digest)]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
    await this.deps.sites.withSiteAssetLock(siteId, () =>
      this.storeOnce(projectId, siteId, hash, kind, asset),
    );
    return {
      ref: assetRefSchema.parse(`asset:${hash}`),
      contentType: asset.contentType,
      size: asset.bytes.byteLength,
      ...(asset.sanitized
        ? {
            warnings: [
              createValidationIssue(
                "asset_sanitized",
                "",
                undefined,
                "warning",
              ),
            ],
          }
        : {}),
    };
  }

  /** The same bytes are stored once, so a repeated upload needs no quota. */
  private async storeOnce(
    projectId: string,
    siteId: string,
    hash: string,
    kind: SiteAssetKind,
    asset: PreparedSiteAsset,
  ): Promise<void> {
    const existing = await this.deps.store.head(siteId, hash);
    if (existing && existing.kind !== kind) {
      throw new SiteConfigValidationError([
        createValidationIssue("asset_wrong_kind"),
      ]);
    }
    if (existing) return;
    await this.assertWithinQuota(projectId, siteId, asset.bytes.byteLength);
    await this.deps.store.write(siteId, hash, asset.bytes, {
      kind,
      contentType: asset.contentType,
      size: asset.bytes.byteLength,
    });
  }

  private async assertWithinQuota(
    projectId: string,
    siteId: string,
    addedBytes: number,
  ): Promise<void> {
    const [limits, usage] = await Promise.all([
      this.deps.storageLimits.getStorageLimits(projectId),
      this.deps.store.usage(siteId),
    ]);
    if (
      usage.files >= limits.maxSiteAssetFiles ||
      usage.bytes + addedBytes > limits.maxSiteAssetBytes
    ) {
      throw new DocsContentError(
        "storage_quota_exceeded",
        "This site stores the most logos, favicons, and social images that the plan allows.",
        { usedBytes: usage.bytes, limitBytes: limits.maxSiteAssetBytes, usedFiles: usage.files, limitFiles: limits.maxSiteAssetFiles },
      );
    }
  }

  private async compress(asset: PreparedSiteAsset, kind: SiteAssetKind): Promise<PreparedSiteAsset> {
    const profile = COMPRESSION_PROFILES[kind];
    if (!profile) return asset;
    const compressed = await compressUploadedImage(this.deps.compressor, asset, profile);
    return compressed ? { ...asset, ...compressed } : asset;
  }

  async preview(
    userId: string,
    projectId: string,
    hash: string,
  ): Promise<Response> {
    const { siteId } = await this.resolveSite(userId, projectId);
    if (!sha256Schema.safeParse(hash).success)
      throw new DocsContentError("not_found", "Asset not found.");
    const asset = await this.deps.store.read(siteId, hash);
    if (!asset) throw new DocsContentError("not_found", "Asset not found.");
    const headers = new Headers({
      "content-type": asset.contentType,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    });
    if (asset.contentType === "image/svg+xml")
      headers.set(
        "content-security-policy",
        "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      );
    return new Response(asset.bytes, { headers });
  }
}
