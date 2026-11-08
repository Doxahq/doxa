/**
 * The storage that MCP upload URLs need. It is small on purpose: the
 * one-file-per-URL rule, the failure count, and the open-upload ledger need
 * a compare-and-swap, which the shared docs object store does not offer.
 */
export interface AgentUploadStore {
  /** The text and the ETag of an object, or null when it is missing. */
  readVersioned(key: string): Promise<{ text: string; etag: string } | null>;
  /**
   * Replaces the object only while its ETag is still `etag`. False when
   * another write changed it first; then nothing is written.
   */
  replaceIfUnchanged(key: string, text: string, etag: string): Promise<boolean>;
  /**
   * Writes the object only while no object has the key. False when another
   * write created it first; then nothing is written.
   */
  createIfAbsent(key: string, text: string): Promise<boolean>;
  readBytes(key: string): Promise<Uint8Array | null>;
  write(key: string, value: string | Uint8Array, contentType: string): Promise<void>;
  removeMany(keys: readonly string[]): Promise<void>;
}

const JSON_TYPE = "application/json; charset=utf-8";

/** `AgentUploadStore` over the R2 binding of a Worker. */
export function createR2AgentUploadStore(bucket: R2Bucket): AgentUploadStore {
  return {
    async readVersioned(key) {
      const object = await bucket.get(key);
      return object ? { text: await object.text(), etag: object.etag } : null;
    },
    // R2 returns null and stores nothing when a condition fails.
    async replaceIfUnchanged(key, text, etag) {
      const written = await bucket.put(key, text, {
        onlyIf: { etagMatches: etag },
        httpMetadata: { contentType: JSON_TYPE },
      });
      return written !== null;
    },
    async createIfAbsent(key, text) {
      // RFC 7232: `If-None-Match: *` passes only when no object exists.
      const written = await bucket.put(key, text, {
        onlyIf: new Headers({ "if-none-match": "*" }),
        httpMetadata: { contentType: JSON_TYPE },
      });
      return written !== null;
    },
    async readBytes(key) {
      const object = await bucket.get(key);
      return object ? new Uint8Array(await object.arrayBuffer()) : null;
    },
    async write(key, value, contentType) {
      await bucket.put(key, value, { httpMetadata: { contentType } });
    },
    async removeMany(keys) {
      if (keys.length > 0) await bucket.delete([...keys]);
    },
  };
}
