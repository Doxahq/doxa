const MONOGRAM_COLOR_COUNT = 8

/**
 * A project's monogram: its initial and a stable fill.
 *
 * Projects have no color field, so the fill comes from a hash of the project
 * id. The same project keeps the same color everywhere.
 */
export function projectMonogram(project: { id: string; name: string }): {
  initial: string
  color: string
} {
  const initial = project.name.trim().charAt(0).toUpperCase() || "?"
  return { initial, color: `var(--monogram-${hashIndex(project.id, MONOGRAM_COLOR_COUNT)})` }
}

function hashIndex(value: string, size: number): number {
  let hash = 0
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return hash % size
}
