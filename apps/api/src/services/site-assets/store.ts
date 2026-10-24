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
  const key = (siteId: string, hash: string) =>
    `sites/${siteId}/assets/${hash}`;
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
  };
}
