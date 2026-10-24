import { buildArtifactPrefix, manifestPathForPrefix } from "@doxahq/docs-engine";
import type { DocsContentStore } from "../../src/services/docs-content/store";

/** Text artifacts, or bytes for binary files such as branch images. */
export type InMemoryObjects = Map<string, string | Uint8Array>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBytes(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? encoder.encode(value) : value;
}

/**
 * A logical docs content store over a plain map of `{prefix}/{path}` keys.
 *
 * It keeps the same rule as the R2 store: a new version stays invisible until
 * its commit. Storage-level behavior (trees and blobs) has its own tests.
 */
export function createInMemoryDocsContentStore(
  objects: InMemoryObjects = new Map(),
): DocsContentStore {
  return {
    read: async (key) => {
      const value = objects.get(key);
      if (value === undefined) return null;
      return typeof value === "string" ? value : decoder.decode(value);
    },
    readBytes: async (key) => {
      const value = objects.get(key);
      return value === undefined ? null : toBytes(value);
    },
    listKeys: async (prefix) =>
      [...objects.keys()].filter((key) => key.startsWith(prefix)).sort(),
    versionSize: async (artifactPrefix) => {
      const files = [...objects].filter(([key]) =>
        key.startsWith(`${artifactPrefix}/`),
      );
      return files.length === 0
        ? null
        : files.reduce((sum, [, value]) => sum + toBytes(value).byteLength, 0);
    },
    openVersion: async ({ siteId, versionId, basePrefix }) => {
      const artifactPrefix = buildArtifactPrefix(siteId, versionId);
      const pending = new Map<string, string | Uint8Array>();
      let committed = false;
      const copyEntry = (sourcePrefix: string, path: string) => {
        const content = objects.get(`${sourcePrefix}/${path}`);
        if (content === undefined) {
          throw new Error(`The folder ${sourcePrefix} has no ${path}.`);
        }
        pending.set(path, content);
      };

      return {
        artifactPrefix,
        async put(path, content) {
          if (committed) throw new Error("The version is already committed.");
          pending.set(path, content);
        },
        async copy(path) {
          if (!basePrefix) throw new Error(`The base folder has no ${path}.`);
          copyEntry(basePrefix, path);
        },
        async copyFrom(sourcePrefix, path) {
          if (!sourcePrefix.startsWith(`sites/${siteId}/versions/`)) {
            throw new Error("A version can only reuse files of its own site.");
          }
          copyEntry(sourcePrefix, path);
        },
        async commit() {
          if (committed) throw new Error("The version is already committed.");
          committed = true;
          for (const [path, content] of pending) {
            objects.set(`${artifactPrefix}/${path}`, content);
          }
          return {
            artifactPrefix,
            manifestPath: manifestPathForPrefix(artifactPrefix),
          };
        },
      };
    },
  };
}
