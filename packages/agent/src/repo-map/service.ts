/**
 * Resolves the repo map for a planning run: cache first, then a build.
 * It never throws. Any failure (a limit, an unreadable tree, an extractor
 * bug) returns null and exploration runs as it did before the map existed.
 */

import { DEFAULT_REPO_MAP_TOKEN_BUDGET } from "./budget";
import { buildRepoMap, type RepoMapLimits } from "./build";
import { repoMapCacheKey, REPO_MAP_FORMAT_VERSION, type RepoMapCache, type RepoMapSourceIdentity } from "./cache";
import { lexicalSymbolExtractor } from "./extractors";
import type { RepoMapSourceEntry, RepoMapSourceTree } from "./source-tree";
import type { RepoMapSnapshot, RepoMapTelemetry, SymbolExtractor } from "./types";

export interface RepoMapOptions {
  /** Where built maps are kept. Without one, every run builds. */
  cache?: RepoMapCache;
  /**
   * Content hash of the checked-out tree, such as a hosted snapshot's
   * `sourceTreeHash`. When set, a cache hit needs no file listing.
   */
  sourceTreeHash?: string;
  tokenBudget?: number;
  extractor?: SymbolExtractor;
  limits?: Partial<RepoMapLimits>;
  /** Build time, size, and cache result of each resolution. Errors in it are ignored. */
  onTelemetry?: (telemetry: RepoMapTelemetry) => void | Promise<void>;
}

export async function resolveRepoMap(
  tree: RepoMapSourceTree,
  options: RepoMapOptions = {},
): Promise<RepoMapSnapshot | null> {
  const startedAt = Date.now();
  const extractor = options.extractor ?? lexicalSymbolExtractor;
  const tokenBudget = options.tokenBudget ?? DEFAULT_REPO_MAP_TOKEN_BUDGET;
  const elapsed = () => Math.max(0, Date.now() - startedAt);

  try {
    let listed: RepoMapSourceEntry[] | undefined;
    let source: RepoMapSourceIdentity;
    if (options.sourceTreeHash) {
      source = { kind: "tree", treeHash: options.sourceTreeHash };
    } else {
      listed = await tree.list();
      source = { kind: "files", entries: listed };
    }
    const key = repoMapCacheKey({ source, extractorVersion: extractor.version, tokenBudget });

    const cached = await readCache(options.cache, key);
    if (cached) {
      await report(options, { status: "ready", cacheHit: true, durationMs: elapsed(), stats: cached.stats });
      return cached;
    }

    const built = await buildRepoMap(tree, { tokenBudget, extractor, limits: options.limits }, listed);
    if (!built.text) {
      await report(options, { status: "skipped", reason: "The token budget cannot hold the map header.", durationMs: elapsed() });
      return null;
    }
    const snapshot: RepoMapSnapshot = { formatVersion: REPO_MAP_FORMAT_VERSION, key, text: built.text, stats: built.stats };
    await writeCache(options.cache, key, snapshot);
    await report(options, { status: "ready", cacheHit: false, durationMs: elapsed(), stats: snapshot.stats });
    return snapshot;
  } catch (error) {
    await report(options, {
      status: "skipped",
      reason: error instanceof Error ? error.message : String(error),
      durationMs: elapsed(),
    });
    return null;
  }
}

/** A cache read failure is a miss: the map can always be rebuilt. */
async function readCache(cache: RepoMapCache | undefined, key: string): Promise<RepoMapSnapshot | null> {
  if (!cache) return null;
  try {
    const snapshot = await cache.get(key);
    return snapshot?.key === key ? snapshot : null;
  } catch {
    return null;
  }
}

async function writeCache(cache: RepoMapCache | undefined, key: string, snapshot: RepoMapSnapshot): Promise<void> {
  if (!cache) return;
  try {
    await cache.set(key, snapshot);
  } catch {
    // The map is still used for this run; the next run rebuilds it.
  }
}

async function report(options: RepoMapOptions, telemetry: RepoMapTelemetry): Promise<void> {
  try {
    await options.onTelemetry?.(telemetry);
  } catch {
    // Telemetry never changes generation behavior.
  }
}
