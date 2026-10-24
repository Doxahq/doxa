import type { ValidationIssue } from "@doxahq/contracts/validation";
import {
  fromJsonPointer,
  isRecord,
  toJsonPointer,
  valueAtPath,
} from "./pointer";

function removalPointer(input: unknown, issue: ValidationIssue): string {
  if (issue.code === "unknown_key") return issue.path;
  const path = fromJsonPointer(issue.path);
  for (let index = path.length - 1; index >= 0; index--) {
    if (Array.isArray(valueAtPath(input, path.slice(0, index)))) {
      return toJsonPointer(path.slice(0, index + 1));
    }
  }
  return issue.path;
}

export function dropInvalidNodes(
  input: unknown,
  issues: readonly ValidationIssue[],
): string[] {
  const pointers = [
    ...new Set(issues.map((issue) => removalPointer(input, issue))),
  ];
  // Remove later array items first so all paths still refer to the same input.
  pointers.sort((left, right) =>
    right.localeCompare(left, "en", { numeric: true }),
  );
  for (const pointer of pointers) dropInvalidNode(input, pointer);
  return pointers;
}

export function dropInvalidNode(input: unknown, pointer: string): string {
  const path = fromJsonPointer(pointer);
  let current = input;
  const visited: string[] = [];
  for (const [offset, key] of path.entries()) {
    if (Array.isArray(current) && offset === path.length - 1) {
      const index = Number(key);
      if (Number.isInteger(index) && index >= 0) current.splice(index, 1);
      return toJsonPointer([...visited, key]);
    }
    if (Array.isArray(current)) {
      visited.push(key);
      current = current[Number(key)];
      continue;
    }
    if (!isRecord(current) || !Object.hasOwn(current, key)) return pointer;
    if (offset === path.length - 1) {
      delete current[key];
      return pointer;
    }
    visited.push(key);
    current = current[key];
  }
  return pointer;
}
