import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  dirname,
  join,
  relative,
  resolve,
} from "node:path";
import type { SourceChangeSet, SourceCheckpoint } from "../state/types";
import type {
  ArtifactEntry,
  ArtifactStore,
  GrepMatch,
  WorkspaceAdapter,
  WorkspaceListOptions,
} from "./types";
import {
  ProjectPathAccessError,
  resolveProjectPath,
} from "../core/tools/project-path";
import { resolveReadableProjectPath } from "../core/tools/file-access-rules";

const DEFAULT_IGNORES = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  ".turbo",
  ".wrangler",
]);

export function createNodeWorkspaceAdapter(root: string): WorkspaceAdapter {
  const resolvedRoot = resolve(root);

  return {
    root: resolvedRoot,

    async readText(path) {
      try {
        const fullPath = await resolveReadableProjectPath(resolvedRoot, path);
        return fullPath === null ? null : await readFile(fullPath, "utf-8");
      } catch (error) {
        if (error instanceof ProjectPathAccessError) throw error;
        return null;
      }
    },

    async listFiles(options = {}) {
      const files = await listFilesRecursive(resolvedRoot, resolvedRoot, options);
      return files.filter((file) => matchesOptions(file, options)).sort();
    },

    async grep(pattern, options = {}) {
      const regex = typeof pattern === "string" ? new RegExp(pattern) : pattern;
      const files = await this.listFiles(options);
      const matches: GrepMatch[] = [];

      for (const file of files) {
        const content = await this.readText(file);
        if (content === null) continue;
        const lines = content.split("\n");
        for (let index = 0; index < lines.length; index++) {
          regex.lastIndex = 0;
          if (regex.test(lines[index])) {
            matches.push({ path: file, line: index + 1, text: lines[index] });
          }
        }
      }

      return matches;
    },

    async hashFile(path) {
      try {
        const content = await readFile(
          await resolveProjectPath(resolvedRoot, path),
        );
        return createHash("sha256").update(content).digest("hex");
      } catch (error) {
        if (error instanceof ProjectPathAccessError) throw error;
        return null;
      }
    },

    async hashFiles(paths) {
      const entries = await Promise.all(
        paths.map(async (path) => [path, await this.hashFile(path)] as const),
      );
      return Object.fromEntries(entries.filter((entry): entry is [string, string] => entry[1] !== null));
    },

    async createCheckpoint() {
      const files = await this.listFiles();
      return {
        generatedAt: new Date().toISOString(),
        headCommitHash: null,
        defaultBranch: null,
        defaultBranchCommitHash: null,
        dirtyFileHashes: await this.hashFiles(files),
        deletedFiles: [],
      };
    },

    async getSourceChanges(checkpoint: SourceCheckpoint | null = null): Promise<SourceChangeSet> {
      const files = await this.listFiles();
      const currentHashes = await this.hashFiles(files);
      if (!checkpoint) {
        return { changedFiles: [], addedFiles: files, deletedFiles: [] };
      }

      const previousHashes = checkpoint.dirtyFileHashes;
      const changedFiles: string[] = [];
      const addedFiles: string[] = [];
      const deletedFiles: string[] = [];

      for (const [path, hash] of Object.entries(currentHashes)) {
        if (!(path in previousHashes)) {
          addedFiles.push(path);
        } else if (previousHashes[path] !== hash) {
          changedFiles.push(path);
        }
      }

      for (const path of Object.keys(previousHashes)) {
        if (!(path in currentHashes)) deletedFiles.push(path);
      }

      return {
        changedFiles: changedFiles.sort(),
        addedFiles: addedFiles.sort(),
        deletedFiles: deletedFiles.sort(),
      };
    },
  };
}

export function createNodeArtifactStore(root: string): ArtifactStore {
  const resolvedRoot = resolve(root);

  return {
    async writeText(path, content) {
      await ensureArtifactRoot(resolvedRoot, true);
      const fullPath = await resolveProjectPath(resolvedRoot, path);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content, "utf-8");
    },

    async readText(path) {
      try {
        if (!(await ensureArtifactRoot(resolvedRoot, false))) return null;
        return await readFile(
          await resolveProjectPath(resolvedRoot, path),
          "utf-8",
        );
      } catch (error) {
        if (error instanceof ProjectPathAccessError) throw error;
        return null;
      }
    },

    async list(prefix = "") {
      if (!(await ensureArtifactRoot(resolvedRoot, false))) return [];
      const files = await listFilesRecursive(resolvedRoot, resolvedRoot, { prefix });
      const entries = await Promise.all(
        files.map(async (path): Promise<ArtifactEntry> => {
          const stats = await stat(
            await resolveProjectPath(resolvedRoot, path),
          );
          return {
            path,
            size: stats.size,
            updatedAt: stats.mtime.toISOString(),
          };
        }),
      );
      return entries.sort((a, b) => a.path.localeCompare(b.path));
    },

    async delete(path) {
      if (!(await ensureArtifactRoot(resolvedRoot, false))) return;
      await rm(await resolveProjectPath(resolvedRoot, path), { force: true });
    },

    async prune(activePaths, prefix = "") {
      const active = new Set(activePaths.map(normalizePath));
      const existing = await this.list(prefix);
      const deleted: string[] = [];

      for (const entry of existing) {
        if (active.has(entry.path)) continue;
        await this.delete(entry.path);
        deleted.push(entry.path);
      }

      return deleted;
    },
  };
}

async function listFilesRecursive(root: string, current: string, options: WorkspaceListOptions): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (!options.includeIgnored && DEFAULT_IGNORES.has(entry.name)) continue;
    const fullPath = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFilesRecursive(root, fullPath, options));
    } else if (entry.isFile()) {
      files.push(normalizePath(relative(root, fullPath)));
    }
  }
  return files;
}

function matchesOptions(path: string, options: WorkspaceListOptions): boolean {
  if (options.prefix && !path.startsWith(normalizePath(options.prefix))) return false;
  if (options.glob && !matchesSimpleGlob(path, options.glob)) return false;
  return true;
}

function matchesSimpleGlob(path: string, glob: string): boolean {
  const normalized = normalizePath(glob);
  if (normalized === "**/*") return true;
  if (normalized.startsWith("**/*.")) return path.endsWith(normalized.slice(4));
  if (normalized.startsWith("*.")) return path.split("/").at(-1)?.endsWith(normalized.slice(1)) ?? false;
  return path.includes(normalized.replace(/\*/g, ""));
}

async function ensureArtifactRoot(
  root: string,
  create: boolean,
): Promise<boolean> {
  if (create) {
    await mkdir(root, { recursive: true });
  }

  try {
    const rootStat = await lstat(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new ProjectPathAccessError();
    }
    return true;
  } catch (error) {
    if (!create && isMissingFileSystemEntry(error)) return false;
    throw error;
  }
}

function isMissingFileSystemEntry(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}
