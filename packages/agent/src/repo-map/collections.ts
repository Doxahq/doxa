/**
 * Code-unit string order. `localeCompare` depends on the runtime's ICU data,
 * and the map must sort the same way everywhere so its cache key and text
 * stay stable.
 */
export function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Appends `value` to the list stored under `key`, creating the list once. */
export function appendToGroup<K, V>(groups: Map<K, V[]>, key: K, value: V): void {
  const group = groups.get(key);
  if (group) group.push(value);
  else groups.set(key, [value]);
}
