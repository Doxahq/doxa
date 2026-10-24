import { sha256Schema } from "@doxahq/contracts/docs-prerender";
import type { SiteAssetUploadResponse } from "@doxahq/contracts/site-assets";
import {
  assetRefSchema,
  createValidationIssue,
  type SiteAssetKind,
} from "@doxahq/site-config";
import { DocsContentError } from "../docs-content/errors";
import { SiteConfigValidationError } from "../site-config-validation";
import { prepareSiteAsset } from "./content";
import type { SiteAssetStore } from "./store";

export interface OwnedSiteLookup {
  getDocsSiteForUser(
    userId: string,
    projectId: string,
  ): Promise<{ siteId: string } | null>;
}

export class SiteAssetsService {
  constructor(
    private readonly sites: OwnedSiteLookup,
    private readonly store: SiteAssetStore,
  ) {}

  private async resolveSite(userId: string, projectId: string) {
    const site = await this.sites.getDocsSiteForUser(userId, projectId);
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
    const asset = prepareSiteAsset(input, kind);
    const digest = await crypto.subtle.digest(
      "SHA-256",
      Uint8Array.from(asset.bytes),
    );
    const hash = [...new Uint8Array(digest)]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
    const existing = await this.store.head(siteId, hash);
    if (existing && existing.kind !== kind) {
      throw new SiteConfigValidationError([
        createValidationIssue("asset_wrong_kind"),
      ]);
    }
    if (!existing)
      await this.store.write(siteId, hash, asset.bytes, {
        kind,
        contentType: asset.contentType,
        size: asset.bytes.byteLength,
      });
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

  async preview(
    userId: string,
    projectId: string,
    hash: string,
  ): Promise<Response> {
    const { siteId } = await this.resolveSite(userId, projectId);
    if (!sha256Schema.safeParse(hash).success)
      throw new DocsContentError("not_found", "Asset not found.");
    const asset = await this.store.read(siteId, hash);
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
