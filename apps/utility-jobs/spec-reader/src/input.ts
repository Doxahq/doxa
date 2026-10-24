import { SPEC_READER_LIMITS, type SpecReaderInput } from "@doxahq/contracts/spec-reader";

export type DecodedInput =
  | { ok: true; input: SpecReaderInput }
  | { ok: false; message: string };

/**
 * The job input: UTF-8 JSON with `roots`, `files` and `unavailable`. The
 * agent container already checked every file at gate G1; this check keeps
 * the job safe from a request that did not pass it.
 */
export function decodeSpecReaderInput(bytes: Uint8Array): DecodedInput {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return invalid("The input is not UTF-8 JSON.");
  }
  if (!isRecord(value)) return invalid("The input is not an object.");

  const { roots, files, unavailable } = value;
  if (!isStringList(roots) || roots.length === 0 || roots.length > SPEC_READER_LIMITS.maxFiles) {
    return invalid("The input needs between 1 and 200 roots.");
  }
  if (!isRecord(files)) return invalid("The input files are not an object.");
  const fileEntries = Object.entries(files);
  if (fileEntries.length > SPEC_READER_LIMITS.maxFiles) return invalid("The input has too many files.");
  const texts: Record<string, string> = {};
  for (const [path, text] of fileEntries) {
    if (typeof text !== "string" || !isRelativeSpecPath(path)) return invalid("The input has an invalid file.");
    texts[path] = text;
  }
  if (!roots.every((root) => Object.hasOwn(texts, root))) return invalid("Every root must be in the files.");
  if (unavailable !== undefined && !isStringList(unavailable)) return invalid("The unavailable files are not a list.");

  return { ok: true, input: { roots, files: texts, ...(unavailable ? { unavailable } : {}) } };
}

/** A relative POSIX path with no `..` segment and a spec file extension. */
function isRelativeSpecPath(path: string): boolean {
  return /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0\\]+\.(?:json|ya?ml)$/i.test(path);
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): DecodedInput {
  return { ok: false, message };
}
