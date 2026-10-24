/**
 * Repo map cache.
 * The key covers every input that changes the text: the source identity (a
 * snapshot tree hash, or a fingerprint of the listed files), the extractor
 * version, the map format version, and the token budget. A snapshot is
 * JSON-safe, so a store outside the process (R2, disk) can hold it and
 * validate it on read with `parseRepoMapSnapshot`.
 */

import { z } from "zod";
import { hashObject } from "../utils/hash";
import { compareStrings } from "./collections";
import type { RepoMapSourceEntry } from "./source-tree";
import type { RepoMapSnapshot } from "./types";

/** Bump when the rendered text can change for the same files and extractor. */
export const REPO_MAP_FORMAT_VERSION = 1;

export interface RepoMapCache {
  get(key: string): Promise<RepoMapSnapshot | null>;
  set(key: string, snapshot: RepoMapSnapshot): Promise<void>;
}

/**
 * What the map was built from. A hosted snapshot already has a content hash
 * of its tree; a local checkout is fingerprinted by path, size, and mtime.
 */
export type RepoMapSourceIdentity =
  | { kind: "tree"; treeHash: string }
  | { kind: "files"; entries: readonly RepoMapSourceEntry[] };

export interface RepoMapCacheKeyInput {
  source: RepoMapSourceIdentity;
  extractorVersion: string;
  tokenBudget: number;
}

export function repoMapCacheKey(input: RepoMapCacheKeyInput): string {
  const source = input.source.kind === "tree"
    ? { kind: "tree", treeHash: input.source.treeHash }
    : {
        kind: "files",
        files: hashObject(
          [...input.source.entries]
            .sort((a, b) => compareStrings(a.path, b.path))
            .map((entry) => [entry.path, entry.size, entry.mtimeMs]),
        ),
      };
  const digest = hashObject({
    formatVersion: REPO_MAP_FORMAT_VERSION,
    extractorVersion: input.extractorVersion,
    tokenBudget: input.tokenBudget,
    source,
  });
  return `repo-map-v${REPO_MAP_FORMAT_VERSION}-${digest}`;
}

const repoMapSnapshotSchema = z.object({
  formatVersion: z.literal(REPO_MAP_FORMAT_VERSION),
  key: z.string().min(1),
  text: z.string(),
  stats: z.object({
    fileCount: z.number().int().nonnegative(),
    sourceFileCount: z.number().int().nonnegative(),
    symbolCount: z.number().int().nonnegative(),
    areaCount: z.number().int().nonnegative(),
    renderedFileCount: z.number().int().nonnegative(),
    tokenEstimate: z.number().int().nonnegative(),
  }),
});

/** A stored snapshot, or null when it is missing, malformed, or another format. */
export function parseRepoMapSnapshot(value: unknown): RepoMapSnapshot | null {
  const parsed = repoMapSnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Process-wide snapshots in least-recently-used order. */
export function createMemoryRepoMapCache(maxEntries = 32): RepoMapCache {
  const entries = new Map<string, RepoMapSnapshot>();
  return {
    async get(key) {
      const snapshot = entries.get(key);
      if (!snapshot) return null;
      entries.delete(key);
      entries.set(key, snapshot);
      return snapshot;
    },
    async set(key, snapshot) {
      entries.delete(key);
      entries.set(key, snapshot);
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
    },
  };
}
