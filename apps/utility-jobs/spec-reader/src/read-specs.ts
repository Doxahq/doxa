import type {
  SpecReaderInput,
  SpecReaderOutput,
  SpecReadOutcome,
} from "@doxahq/contracts/spec-reader";
import { SpecFiles } from "./document/spec-files";
import { readSpec } from "./read-spec";

/**
 * One job call. When a `$ref` needs a file that the request did not carry,
 * the result asks for it instead, and the agent container calls again with
 * more files. A root that another spec references is a part of that spec,
 * not a spec of its own, so it is left out.
 */
export function readSpecs(input: SpecReaderInput, readerVersion: string): SpecReaderOutput {
  const files = new SpecFiles(new Map(Object.entries(input.files)), new Set(input.unavailable ?? []));
  const specs = input.roots.map((root) => readSpecSafely(root, files));
  if (files.missing.size > 0) {
    return { status: "need_files", needFiles: [...files.missing].sort() };
  }
  return { status: "read", readerVersion, specs: withoutPartSpecs(specs), fileIssues: files.issues() };
}

function readSpecSafely(root: string, files: SpecFiles): SpecReadOutcome {
  try {
    return readSpec(root, files);
  } catch {
    return { outcome: "rejected", root, code: "parse_failed", message: "The spec could not be read." };
  }
}

function withoutPartSpecs(specs: readonly SpecReadOutcome[]): SpecReadOutcome[] {
  const parts = new Set(
    specs.flatMap((spec) => (spec.outcome === "parsed" ? spec.files.slice(1) : [])),
  );
  return specs.filter((spec) => !parts.has(spec.root));
}
