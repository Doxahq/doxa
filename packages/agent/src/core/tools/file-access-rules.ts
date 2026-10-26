/**
 * Which repository files the exploration tools never show to the model.
 *
 * Read and Grep share these rules, so one tool cannot reveal a file that the
 * other one refuses.
 */

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
] as const;

/** Lockfiles: too large to help, so Read skips them. Grep may still search them. */
const LARGE_FILE_PATTERNS: readonly RegExp[] = [
  /(^|\/)bun\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)yarn\.lock$/,
];

const SENSITIVE_FILE_PATTERNS: readonly RegExp[] = SENSITIVE_FILE_GLOBS.map(globToBasenamePattern);

export function isSensitiveFilePath(path: string): boolean {
  const normalized = normalizePath(path);
  return SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(normalized));
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
