import { SPEC_READER_LIMITS, type SkippedSpecOperation, type SpecSkipCode } from "@doxahq/contracts/spec-reader";
import { entriesOf, isSpecObject, isTrue, valueAt, type SpecObject } from "../document/tree";
import type { Located, ReferenceResolver } from "../references/resolver";
import { isCustomMethod, pathProblem, STANDARD_METHODS } from "./operation-checks";
import { cutText } from "./text";

export interface CollectedOperation {
  /** Upper case. */
  method: string;
  path: string;
  operation: Located<SpecObject>;
  /** The `parameters` of the path item, which the operation's own parameters replace by name. */
  pathItemParameters?: Located;
}

export type CollectResult =
  | { ok: true; operations: CollectedOperation[]; skipped: SkippedSpecOperation[] }
  /** The spec has more operations than the D9 ceiling. */
  | { ok: false };

/**
 * Every operation of `paths` in spec order: the standard methods, the 3.2
 * `query` method and the 3.2 `additionalOperations`. A path or operation
 * marked `x-internal` or `x-hidden` is left out. An operation with a bad
 * path or method is skipped and reported.
 */
export function collectOperations(
  root: Located<SpecObject>,
  paths: SpecObject,
  resolver: ReferenceResolver,
): CollectResult {
  const operations: CollectedOperation[] = [];
  const skipped: SkippedSpecOperation[] = [];

  for (const [path, rawItem] of entriesOf(paths)) {
    const resolution = resolver.resolve({ value: rawItem, file: root.file });
    if (!resolution.ok || !isSpecObject(resolution.resolved.value)) {
      skipped.push(skippedOperation("ANY", path, "invalid_path_item", resolution.ok
        ? "The path item is not an object."
        : resolution.failure.message));
      continue;
    }
    const item: Located<SpecObject> = { value: resolution.resolved.value, file: resolution.resolved.file };
    if (isHidden(item.value)) continue;

    const problem = pathProblem(path);
    for (const candidate of methodsOf(item)) {
      if ("skipped" in candidate) {
        skipped.push(skippedOperation(candidate.method, path, "invalid_method", candidate.skipped));
      } else if (problem) {
        skipped.push(skippedOperation(candidate.method, path, "invalid_path", problem));
      } else if (!isHidden(candidate.operation.value)) {
        const parameters = valueAt(item.value, "parameters");
        operations.push({
          method: candidate.method,
          path,
          operation: candidate.operation,
          ...(parameters === undefined ? {} : { pathItemParameters: { value: parameters, file: item.file } }),
        });
        if (operations.length > SPEC_READER_LIMITS.maxOperations) return { ok: false };
      }
    }
  }
  return { ok: true, operations, skipped };
}

/** A skipped operation, with its path made safe to report. */
export function skippedOperation(
  method: string,
  path: string,
  code: SpecSkipCode,
  message: string,
): SkippedSpecOperation {
  return {
    method,
    path: cutText(path.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?"), SPEC_READER_LIMITS.maxNameChars),
    code,
    message,
  };
}

type MethodCandidate =
  | { method: string; operation: Located<SpecObject> }
  | { method: string; skipped: string };

function methodsOf(item: Located<SpecObject>): MethodCandidate[] {
  const candidates: MethodCandidate[] = [];
  for (const [key, value] of entriesOf(item.value)) {
    if (STANDARD_METHODS.includes(key) && isSpecObject(value)) {
      candidates.push({ method: key.toUpperCase(), operation: { value, file: item.file } });
    } else if (key === "additionalOperations" && isSpecObject(value)) {
      candidates.push(...additionalOperations(value, item.file));
    }
  }
  return candidates;
}

/** 3.2 operations with other methods, such as `PURGE`. A standard method may not appear here. */
function additionalOperations(operations: SpecObject, file: string): MethodCandidate[] {
  return entriesOf(operations).flatMap(([method, value]): MethodCandidate[] => {
    if (!isSpecObject(value)) return [];
    const reported = cutText(method.replace(/[^\x20-\x7e]/g, "?"), 20);
    if (!isCustomMethod(method)) {
      return [{ method: reported, skipped: "An additional method must be an upper-case HTTP token." }];
    }
    if (STANDARD_METHODS.includes(method.toLowerCase())) {
      return [{ method, skipped: "A standard method cannot be an additional operation." }];
    }
    return [{ method, operation: { value, file } }];
  });
}

function isHidden(value: SpecObject): boolean {
  return isTrue(value, "x-internal") || isTrue(value, "x-hidden");
}
