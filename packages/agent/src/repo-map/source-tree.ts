import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { listProjectFiles } from "../utils/runtime";
import { compareStrings } from "./collections";

export interface RepoMapSourceEntry {
  path: string;
  size: number;
  mtimeMs: number;
}

/** The files a repo map reads. The node tree reads a checkout; tests use memory. */
export interface RepoMapSourceTree {
  list(): Promise<RepoMapSourceEntry[]>;
  readText(path: string): Promise<string | null>;
}

/** Stats of files listed together, to keep open file handles bounded. */
const STAT_BATCH_SIZE = 64;

/**
 * A tree over a project directory with the same file listing and ignore
 * rules as the exploration tools (`listProjectFiles`). Symbolic links are
 * not listed, so reads stay inside the checkout.
 */
export function createNodeRepoMapSourceTree(root: string): RepoMapSourceTree {
  return {
    async list() {
      const paths = (await listProjectFiles(root)).sort(compareStrings);
      const entries: RepoMapSourceEntry[] = [];
      for (let start = 0; start < paths.length; start += STAT_BATCH_SIZE) {
        const batch = await Promise.all(paths.slice(start, start + STAT_BATCH_SIZE).map(async (path) => {
          try {
            const stats = await stat(join(root, path));
            return { path, size: stats.size, mtimeMs: stats.mtimeMs };
          } catch {
            return null;
          }
        }));
        for (const entry of batch) if (entry) entries.push(entry);
      }
      return entries;
    },
    async readText(path) {
      try {
        return await readFile(join(root, path), "utf-8");
      } catch {
        return null;
      }
    },
  };
}

/** A tree over in-memory files. Every file has the same mtime, so keys depend on content size only. */
export function createMemoryRepoMapSourceTree(files: Readonly<Record<string, string>>): RepoMapSourceTree {
  return {
    async list() {
      return Object.keys(files)
        .sort(compareStrings)
        .map((path) => ({ path, size: new TextEncoder().encode(files[path]).length, mtimeMs: 0 }));
    },
    async readText(path) {
      return Object.hasOwn(files, path) ? files[path] : null;
    },
  };
}
