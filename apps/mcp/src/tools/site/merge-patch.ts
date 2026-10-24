type JsonObject = Record<string, unknown>;

/**
 * JSON Merge Patch (RFC 7396). Pure: neither argument is changed. A null in
 * the patch removes the member; an object merges recursively; any other value,
 * arrays included, replaces the target.
 */
export function applyMergePatch(target: unknown, patch: unknown): unknown {
  if (!isJsonObject(patch)) return patch;
  const result = new Map(Object.entries(isJsonObject(target) ? target : {}));
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      result.delete(key);
    } else {
      result.set(key, applyMergePatch(result.get(key), value));
    }
  }
  // fromEntries defines own properties, so a "__proto__" key stays data and
  // never changes the result's prototype.
  return Object.fromEntries(result);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
