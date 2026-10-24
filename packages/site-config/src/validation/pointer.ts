export function toJsonPointer(path: readonly PropertyKey[]): string {
  return path
    .map((key) => `/${String(key).replace(/~/g, "~0").replace(/\//g, "~1")}`)
    .join("");
}

export function fromJsonPointer(pointer: string): string[] {
  return pointer === ""
    ? []
    : pointer
        .slice(1)
        .split("/")
        .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
}

export function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

export function valueAtPath(
  input: unknown,
  path: readonly PropertyKey[],
): unknown {
  let current = input;
  for (const key of path) {
    if (Array.isArray(current)) current = current[Number(key)];
    else if (isRecord(current) && Object.hasOwn(current, key))
      current = current[String(key)];
    else return undefined;
  }
  return current;
}
