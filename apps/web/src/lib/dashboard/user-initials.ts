/** Up to two initials of a name or email, for an avatar: "Sam Lee" → "SL", "sam@acme.dev" → "S". */
export function userInitials(name: string): string {
  const parts = name.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean)
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase()
}
