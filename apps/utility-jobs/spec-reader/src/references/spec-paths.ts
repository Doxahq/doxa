import { posix } from "node:path";

/** The file types a spec may reference. */
const SPEC_FILE_EXTENSION = /\.(?:json|ya?ml)$/i;

export function isSpecFilePath(path: string): boolean {
  return SPEC_FILE_EXTENSION.test(path);
}

/**
 * Resolves a relative file reference against the file that holds it. The
 * result is a relative POSIX path inside the checkout, or undefined for an
 * absolute path, a backslash, a NUL byte, bad percent-encoding, or a path
 * that leaves the checkout.
 */
export function resolveRelativeSpecPath(fromFile: string, reference: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(reference);
  } catch {
    return undefined;
  }
  if (decoded.startsWith("/") || decoded.includes("\\") || decoded.includes("\0")) return undefined;

  const resolved = posix.normalize(posix.join(posix.dirname(fromFile), decoded));
  if (resolved === ".." || resolved.startsWith("../") || posix.isAbsolute(resolved)) return undefined;
  return resolved;
}
