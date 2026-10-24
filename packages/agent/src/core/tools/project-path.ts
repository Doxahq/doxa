import { lstat, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

export const PROJECT_PATH_ACCESS_ERROR_CODE = "PROJECT_PATH_ACCESS_DENIED";

export class ProjectPathAccessError extends Error {
  readonly code = PROJECT_PATH_ACCESS_ERROR_CODE;

  constructor() {
    super(`${PROJECT_PATH_ACCESS_ERROR_CODE}: Repository path access denied.`);
    this.name = "ProjectPathAccessError";
  }
}

interface ExistingPathResolution {
  canonicalPath: string;
  missingSegments: string[];
}

export async function resolveProjectPath(
  projectRoot: string,
  requestedPath: string,
): Promise<string> {
  const lexicalRoot = resolve(projectRoot);
  const normalizedRequest = normalizeSeparators(requestedPath);
  const lexicalPath = isAbsolute(normalizedRequest)
    ? resolve(normalizedRequest)
    : resolve(lexicalRoot, normalizedRequest);

  const lexicalRelativePath = assertProjectRelativePath(lexicalRoot, lexicalPath);
  assertGitMetadataDenied(lexicalRelativePath);

  const canonicalRoot = await resolveCanonicalRoot(lexicalRoot);
  const existingPath = await resolveNearestExistingPath(lexicalPath);
  const canonicalPath = resolve(
    existingPath.canonicalPath,
    ...existingPath.missingSegments,
  );
  const canonicalRelativePath = assertProjectRelativePath(canonicalRoot, canonicalPath);
  assertGitMetadataDenied(canonicalRelativePath);

  return canonicalPath;
}

function normalizeSeparators(path: string): string {
  return path.replace(/[\\/]+/g, sep);
}

function assertProjectRelativePath(projectRoot: string, candidatePath: string): string {
  const relativePath = relative(projectRoot, candidatePath);
  const escapesRoot = relativePath === ".."
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath);

  if (escapesRoot) {
    throw new ProjectPathAccessError();
  }

  return relativePath;
}

function assertGitMetadataDenied(relativePath: string): void {
  if (relativePath.split(sep).includes(".git")) {
    throw new ProjectPathAccessError();
  }
}

async function resolveCanonicalRoot(projectRoot: string): Promise<string> {
  try {
    return await realpath(projectRoot);
  } catch {
    throw new ProjectPathAccessError();
  }
}

async function resolveNearestExistingPath(
  candidatePath: string,
): Promise<ExistingPathResolution> {
  let currentPath = candidatePath;
  const missingSegments: string[] = [];

  while (true) {
    try {
      return {
        canonicalPath: await realpath(currentPath),
        missingSegments,
      };
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw new ProjectPathAccessError();
      }
      if (await pathEntryExists(currentPath)) {
        try {
          return {
            canonicalPath: await realpath(currentPath),
            missingSegments,
          };
        } catch {
          // The entry may be a broken symlink, or may have disappeared
          // during resolution. Neither case is safe to treat as a new path.
          throw new ProjectPathAccessError();
        }
      }
    }

    const parentPath = dirname(currentPath);
    if (parentPath === currentPath) {
      throw new ProjectPathAccessError();
    }

    missingSegments.unshift(basename(currentPath));
    currentPath = parentPath;
  }
}

async function pathEntryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw new ProjectPathAccessError();
  }
}

function isMissingPathError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) {
    return false;
  }

  return error.code === "ENOENT" || error.code === "ENOTDIR";
}
