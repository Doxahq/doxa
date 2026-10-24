/**
 * The base ID, or the base with `-2`, `-3` when an earlier entry took it.
 * The ID joins `taken`.
 */
export function uniqueId(base: string, taken: Set<string>): string {
  let id = base;
  for (let suffix = 2; taken.has(id); suffix += 1) id = `${base}-${suffix}`;
  taken.add(id);
  return id;
}
