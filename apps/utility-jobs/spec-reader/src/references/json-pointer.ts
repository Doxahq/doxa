import { isSpecArray, isSpecObject, valueAt, type SpecValue } from "../document/tree";

/**
 * The segments of a JSON pointer such as `/components/schemas/User`, with
 * `~1` decoded to `/` and then `~0` to `~`. The empty pointer is the whole
 * document. Anything else that does not start with `/` is not a pointer.
 */
export function parseJsonPointer(pointer: string): string[] | undefined {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) return undefined;
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

/** The value at a pointer, reading own keys and canonical array indexes only. */
export function valueAtPointer(root: SpecValue, segments: readonly string[]): SpecValue | undefined {
  let current: SpecValue | undefined = root;
  for (const segment of segments) {
    if (isSpecArray(current)) {
      current = /^(?:0|[1-9]\d*)$/.test(segment) ? current[Number(segment)] : undefined;
    } else if (isSpecObject(current)) {
      current = valueAt(current, segment);
    } else {
      return undefined;
    }
  }
  return current;
}
