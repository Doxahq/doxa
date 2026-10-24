import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { SPEC_READER_LIMITS } from "@doxahq/contracts/spec-reader";
import { resolveProjectPath } from "../core/tools/project-path";

export type SpecFileRefusal =
  | "invalid_path"
  | "outside_checkout"
  | "symbolic_link"
  | "not_a_file"
  | "too_large"
  | "not_utf8"
  | "nul_byte"
  | "unreadable";

export type SpecFileGateResult =
  | { ok: true; text: string }
  | { ok: false; refusal: SpecFileRefusal };

/** A relative POSIX path to a `.json`, `.yaml` or `.yml` file with no `..` segment. */
const SPEC_FILE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0\\]+\.(?:json|ya?ml)$/i;

/**
 * Gate G1: reads one spec file for the spec-reader job. The path must stay
 * inside the checkout with no symbolic link on the way and no `.git`
 * segment, the file is at most 25 MB, and its bytes are UTF-8 with no NUL.
 * A BOM is removed and line endings become `\n`. The gate parses nothing.
 */
export async function readSpecFile(checkoutRoot: string, path: string): Promise<SpecFileGateResult> {
  if (!SPEC_FILE_PATH.test(path)) return refuse("invalid_path");

  let canonicalPath: string;
  let expectedPath: string;
  try {
    canonicalPath = await resolveProjectPath(checkoutRoot, path);
    expectedPath = join(await realpath(checkoutRoot), path);
  } catch {
    return refuse("outside_checkout");
  }
  // A link anywhere on the way makes the canonical path differ from the plain one.
  if (canonicalPath !== expectedPath) return refuse("symbolic_link");

  try {
    const stats = await lstat(canonicalPath);
    if (stats.isSymbolicLink()) return refuse("symbolic_link");
    if (!stats.isFile()) return refuse("not_a_file");
    if (stats.size > SPEC_READER_LIMITS.maxFileBytes) return refuse("too_large");
    return decodeSpecText(await readFile(canonicalPath));
  } catch {
    return refuse("unreadable");
  }
}

/** UTF-8 text with no NUL byte, the BOM removed and `\n` line endings. */
export function decodeSpecText(bytes: Uint8Array): SpecFileGateResult {
  if (bytes.includes(0)) return refuse("nul_byte");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return refuse("not_utf8");
  }
  return { ok: true, text: text.replace(/\r\n?/g, "\n") };
}

function refuse(refusal: SpecFileRefusal): SpecFileGateResult {
  return { ok: false, refusal };
}
