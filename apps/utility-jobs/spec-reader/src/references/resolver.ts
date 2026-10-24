import { SPEC_READER_LIMITS, type SpecSkipCode } from "@doxahq/contracts/spec-reader";
import type { SpecFiles } from "../document/spec-files";
import { isSpecObject, stringAt, type SpecValue } from "../document/tree";
import { valueAtPointer } from "./json-pointer";
import { referenceTarget } from "./reference-target";

/** A value and the file it came from; relative references resolve against that file. */
export interface Located<T extends SpecValue = SpecValue> {
  value: T;
  file: string;
}

export interface Resolved extends Located {
  /** The last pointer segment of the last `$ref`, such as `Order`. */
  name?: string;
  /** The `file#pointer` of the last `$ref`, the identity of a named schema. */
  key?: string;
  /** The `description` next to the first `$ref`, which OpenAPI 3.1 lets override the target. */
  description?: string;
}

export type ReferenceFailureCode = Extract<
  SpecSkipCode,
  "invalid_reference" | "missing_reference" | "unresolved_reference" | "reference_cycle" | "reference_chain_too_long"
>;

export interface ReferenceFailure {
  code: ReferenceFailureCode;
  message: string;
}

export type Resolution =
  | { ok: true; resolved: Resolved }
  | { ok: false; failure: ReferenceFailure };

/**
 * Follows `$ref` values lazily, one value at a time: nothing is copied or
 * expanded ahead. A chain of references stops at 64, and a chain that comes
 * back to a target it already visited is a cycle.
 */
export class ReferenceResolver {
  /** Every file that a followed reference read. */
  readonly usedFiles = new Set<string>();

  constructor(private readonly files: SpecFiles) {}

  resolve(located: Located): Resolution {
    let current: Resolved = located;
    const visited = new Set<string>();

    for (let hops = 0; ; hops += 1) {
      const value = current.value;
      const reference = isSpecObject(value) ? stringAt(value, "$ref") : undefined;
      if (reference === undefined) return { ok: true, resolved: current };
      if (hops >= SPEC_READER_LIMITS.maxReferenceChain) {
        return failure("reference_chain_too_long", "A reference chain is longer than 64 references.");
      }

      const targetResult = referenceTarget(reference, current.file);
      if (!targetResult.ok) return failure("invalid_reference", targetResult.message);
      const { target } = targetResult;
      if (visited.has(target.key)) {
        return failure("reference_cycle", "A reference chain comes back to itself.");
      }
      visited.add(target.key);

      const lookup = this.files.lookup(target.file);
      if (lookup.status === "missing") {
        return failure("missing_reference", "A referenced file was not sent.");
      }
      if (lookup.status !== "found") {
        return failure("unresolved_reference", "A referenced file cannot be read.");
      }
      const targetValue = valueAtPointer(lookup.value, target.pointer);
      if (targetValue === undefined) {
        return failure("unresolved_reference", "A reference points to nothing.");
      }

      this.usedFiles.add(target.file);
      current = {
        value: targetValue,
        file: target.file,
        name: target.pointer.at(-1),
        key: target.key,
        description: current.description ?? (isSpecObject(value) ? stringAt(value, "description") : undefined),
      };
    }
  }
}

function failure(code: ReferenceFailureCode, message: string): Resolution {
  return { ok: false, failure: { code, message } };
}
