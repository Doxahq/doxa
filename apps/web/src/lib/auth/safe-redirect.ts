/** Where a person goes after sign-in when no safe redirect is given. */
export const DEFAULT_REDIRECT_PATH = "/dashboard"

export const MAX_REDIRECT_LENGTH = 2048

/** Times to decode a value to find a hidden `//` or `/\`. */
const MAX_DECODE_PASSES = 3

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
/** The base for resolving a path. It never leaves this module. */
const RESOLVE_BASE = "https://doxa.invalid"

/**
 * Returns a same-origin path (with search and hash) that is safe to open after
 * sign-in, or `/dashboard`.
 *
 * It accepts a relative path that starts with one `/`. It also accepts a full
 * URL on `origin` (the current origin by default) and keeps only its path,
 * search, and hash. It rejects every other value, so the login page cannot
 * send a person to another site.
 */
export function sanitizeRedirectPath(value: unknown, origin = currentOrigin()): string {
  if (typeof value !== "string") return DEFAULT_REDIRECT_PATH
  if (value.length === 0 || value.length > MAX_REDIRECT_LENGTH) return DEFAULT_REDIRECT_PATH
  if (CONTROL_CHARACTERS.test(value) || value.includes("\\")) return DEFAULT_REDIRECT_PATH

  const path = value.startsWith("/") ? value : sameOriginPath(value, origin)
  if (path === null || !isSafeRelativePath(path)) return DEFAULT_REDIRECT_PATH

  return path
}

function sameOriginPath(value: string, origin: string | null): string | null {
  if (origin === null) return null

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null
  if (url.username || url.password) return null
  if (url.origin !== origin) return null

  return `${url.pathname}${url.search}${url.hash}`
}

function isSafeRelativePath(path: string): boolean {
  if (!startsAsLocalPath(path)) return false

  // Reject encoded forms of `//` and `/\`, also double-encoded ones.
  let decoded = path
  for (let pass = 0; pass < MAX_DECODE_PASSES; pass += 1) {
    const next = safeDecode(decoded)
    if (next === null) return false
    if (!startsAsLocalPath(next) || CONTROL_CHARACTERS.test(next)) return false
    if (next === decoded) break
    decoded = next
  }

  // The browser must resolve the path on the same origin.
  try {
    return new URL(path, RESOLVE_BASE).origin === RESOLVE_BASE
  } catch {
    return false
  }
}

function startsAsLocalPath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/\\")
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

function currentOrigin(): string | null {
  return typeof window === "undefined" ? null : window.location.origin
}
