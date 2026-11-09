import {
  siteAssetContentTypeSchema,
  siteAssetKindSchema,
  type SiteAssetContentType,
  type SiteAssetKind,
} from "@doxahq/site-config";

export interface SiteAssetMetadata {
  contentType: SiteAssetContentType;
  size: number;
  kind: SiteAssetKind;
}
export interface SiteAssetStore {
  head(siteId: string, hash: string): Promise<SiteAssetMetadata | null>;
  read(
    siteId: string,
    hash: string,
  ): Promise<(SiteAssetMetadata & { bytes: ArrayBuffer }) | null>;
  write(
    siteId: string,
    hash: string,
    bytes: Uint8Array,
    metadata: SiteAssetMetadata,
  ): Promise<void>;
  /** What the site stores now. */
  usage(siteId: string): Promise<SiteAssetUsage>;
}

export interface SiteAssetUsage {
  files: number;
  bytes: number;
}

function metadata(object: R2Object): SiteAssetMetadata | null {
  const contentType = siteAssetContentTypeSchema.safeParse(
    object.httpMetadata?.contentType,
  );
  const kind = siteAssetKindSchema.safeParse(object.customMetadata?.kind);
  if (!contentType.success || !kind.success) return null;
  return { contentType: contentType.data, kind: kind.data, size: object.size };
}

export function createR2SiteAssetStore(bucket: R2Bucket): SiteAssetStore {
  const prefix = (siteId: string) => `sites/${siteId}/assets/`;
  const key = (siteId: string, hash: string) => `${prefix(siteId)}${hash}`;
  return {
    async head(siteId, hash) {
      const object = await bucket.head(key(siteId, hash));
      if (!object) return null;
      const info = metadata(object);
      if (!info) throw new Error("Stored site asset metadata is invalid.");
      return info;
    },
    async read(siteId, hash) {
      const object = await bucket.get(key(siteId, hash));
      const info = object ? metadata(object) : null;
      return object && info
        ? { ...info, bytes: await object.arrayBuffer() }
        : null;
    },
    async write(siteId, hash, bytes, info) {
      await bucket.put(key(siteId, hash), bytes, {
        httpMetadata: { contentType: info.contentType },
        customMetadata: { kind: info.kind },
      });
    },
    async usage(siteId) {
      const usage: SiteAssetUsage = { files: 0, bytes: 0 };
      let cursor: string | undefined;
      do {
        const page = await bucket.list({ prefix: prefix(siteId), cursor });
        for (const object of page.objects) {
          usage.files += 1;
          usage.bytes += object.size;
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return usage;
    },
  };
}
