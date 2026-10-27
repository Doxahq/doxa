/**
 * Which repository files the model never sees.
 *
 * Every reader that sends repository text to a model shares these rules: the
 * Read and Grep tools, the repository notes loader, writer evidence and the
 * analysis. So no reader can reveal a file that another one refuses.
 */

import { DOXABOT_REPOSITORY_INSTRUCTIONS_PATH } from "@doxahq/contracts";
import { resolveProjectPath } from "./project-path";

/** Files that can hold credentials. No tool returns their content. */
export const SENSITIVE_FILE_GLOBS = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa*",
  "id_ed25519*",
  ".npmrc",
  ".netrc",
  ".pypirc",
  // Cloudflare Workers local secrets, and direnv files that export secrets.
  ".dev.vars",
  ".dev.vars.*",
  ".envrc",
] as const;

/**
 * Files that reach the model only through their own screened prompt block.
 * The repository instructions file is screened before use, so a tool must not
 * return its raw text, flagged or not.
 */
const SCREENED_FILE_PATHS = [DOXABOT_REPOSITORY_INSTRUCTIONS_PATH] as const;

/** Lockfiles: too large to help, so Read skips them. Grep may still search them. */
const LARGE_FILE_PATTERNS: readonly RegExp[] = [
  /(^|\/)bun\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)yarn\.lock$/,
];

const SENSITIVE_FILE_PATTERNS: readonly RegExp[] = SENSITIVE_FILE_GLOBS.map(globToBasenamePattern);

const SCREENED_FILE_PATTERNS: readonly RegExp[] = SCREENED_FILE_PATHS.map(
  (path) => new RegExp(`(^|/)${path.replace(/[.+^${}()|[\]\\]/g, "\\$&")}$`),
);

export function isSensitiveFilePath(path: string): boolean {
  const normalized = normalizePath(path);
  return SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * True when no reader may send the file's text to a model: a credential file
 * or a screened file. Check both the requested path and its resolved path, so
 * a harmless-looking symlink cannot point at a protected file.
 */
export function isProtectedFilePath(path: string): boolean {
  const normalized = normalizePath(path);
  return isSensitiveFilePath(normalized)
    || SCREENED_FILE_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Resolves a repository path for a reader whose text goes to a model. Returns
 * null for a protected file. Like {@link resolveProjectPath}, it throws
 * `ProjectPathAccessError` for a path outside the repository.
 */
export async function resolveReadableProjectPath(projectRoot: string, path: string): Promise<string | null> {
  const fullPath = await resolveProjectPath(projectRoot, path);
  return isProtectedFilePath(path) || isProtectedFilePath(fullPath) ? null : fullPath;
}

export function isLargeFilePath(path: string): boolean {
  const normalized = normalizePath(path);
  return LARGE_FILE_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * True when a file glob from the model could select a sensitive file, for
 * example ".env*" or "*". Grep then keeps its own include list.
 */
export function globCanSelectSensitiveFile(glob: string): boolean {
  const pattern = globToBasenamePattern(glob);
  return SENSITIVE_SAMPLE_NAMES.some((name) => pattern.test(name));
}

/** One example name for each sensitive glob, used to test model globs. */
const SENSITIVE_SAMPLE_NAMES = [
  ".env",
  ".env.local",
  "server.pem",
  "server.key",
  "cert.p12",
  "cert.pfx",
  "id_rsa",
  "id_ed25519",
  ".npmrc",
  ".netrc",
  ".pypirc",
  ".dev.vars",
  ".dev.vars.local",
  ".envrc",
] as const;

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

/** Converts a basename glob (`*` and `?` only) into a pattern for the last path segment. */
function globToBasenamePattern(glob: string): RegExp {
  const source = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`(^|/)${source}$`);
}
