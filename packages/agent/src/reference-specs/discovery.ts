import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { SPEC_READER_LIMITS } from "@doxahq/contracts/spec-reader";
import { listProjectFiles } from "../utils/runtime";
import { isKnownSpecFileName } from "./spec-paths";

/** Root spec files that one run reads; a monorepo with more keeps the first by path. */
export const MAX_SPEC_ROOTS = 50;

/** Bytes read first from a candidate to find its version line. */
const SNIFF_BYTES = 4 * 1024;

const SPEC_FOLDERS: ReadonlySet<string> = new Set(["api", "docs", "spec", "specs", "openapi"]);
const SPEC_EXTENSION = /\.(?:json|ya?ml)$/i;

/** Folders whose specs describe tests, fixtures, examples or vendored code, not the product. */
const SKIPPED_FOLDERS: ReadonlySet<string> = new Set([
  "vendor",
  "third_party",
  "third-party",
  "test",
  "tests",
  "__tests__",
  "__mocks__",
  "fixtures",
  "__fixtures__",
  "testdata",
  "e2e",
  "example",
  "examples",
]);

/** A YAML spec root: a top-level `openapi: 3.x` or `swagger: "2.0"` line. */
const YAML_VERSION_LINE = /^["']?(?:openapi["']?[ \t]*:[ \t]*["']?3\.[0-2]|swagger["']?[ \t]*:[ \t]*["']?2\.0)/m;
/** A JSON spec root: an `"openapi": "3.x"` or `"swagger": "2.0"` member, minified or not. */
const JSON_VERSION_MEMBER = /"(?:openapi"\s*:\s*"3\.[0-2]|swagger"\s*:\s*"2\.0)/;

/**
 * The spec files of a checkout, sorted by path. Configured paths win;
 * otherwise known file names, and spec files under `api/`, `docs/`,
 * `spec/`, `specs/` and `openapi/`, that name an OpenAPI 3.0 to 3.2 or
 * Swagger 2.0 root. Discovery reads text and parses nothing. Gate G1 checks
 * every file again before it is sent, and reports a file it refuses.
 */
export async function discoverSpecFiles(
  checkoutRoot: string,
  configuredPaths: readonly string[] = [],
): Promise<string[]> {
  if (configuredPaths.length > 0) return [...new Set(configuredPaths)].sort().slice(0, MAX_SPEC_ROOTS);

  const candidates = (await listProjectFiles(checkoutRoot))
    .filter(isCandidatePath)
    .sort();
  const roots: string[] = [];
  for (const path of candidates) {
    if (await looksLikeSpec(checkoutRoot, path)) roots.push(path);
    if (roots.length === MAX_SPEC_ROOTS) break;
  }
  return roots;
}

export function isCandidatePath(path: string): boolean {
  if (!SPEC_EXTENSION.test(path)) return false;
  const folders = path.split("/").slice(0, -1);
  if (folders.some((folder) => folder.startsWith(".") || SKIPPED_FOLDERS.has(folder))) return false;
  return isKnownSpecFileName(path) || folders.some((folder) => SPEC_FOLDERS.has(folder));
}

/**
 * Whether a candidate names a spec version. The first 4 KB usually do; a
 * spec with sorted keys, such as Stripe's, names it megabytes later, so the
 * rest of the file is read too. A file over the size limit is kept when its
 * head or its name marks it as a spec, so that gate G1 reports it as too
 * large instead of the run reporting no spec.
 */
async function looksLikeSpec(checkoutRoot: string, path: string): Promise<boolean> {
  const versionPattern = path.toLowerCase().endsWith(".json") ? JSON_VERSION_MEMBER : YAML_VERSION_LINE;
  let file: FileHandle | undefined;
  try {
    file = await open(join(checkoutRoot, path), "r");
    const stats = await file.stat();
    if (!stats.isFile()) return false;
    if (versionPattern.test(await readHead(file, Math.min(SNIFF_BYTES, stats.size)))) return true;
    if (stats.size > SPEC_READER_LIMITS.maxFileBytes) return isKnownSpecFileName(path);
    if (stats.size <= SNIFF_BYTES) return false;
    return versionPattern.test(await readHead(file, stats.size));
  } catch {
    return false;
  } finally {
    await file?.close();
  }
}

async function readHead(file: FileHandle, bytes: number): Promise<string> {
  const buffer = Buffer.alloc(bytes);
  const { bytesRead } = await file.read(buffer, 0, bytes, 0);
  return buffer.toString("utf8", 0, bytesRead);
}
