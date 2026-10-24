/**
 * Better Auth names its session cookie `{prefix}.session_token`. The prefix is
 * `better-auth` unless the API sets `AUTH_COOKIE_PREFIX` (for example
 * `doxa-dev` in local development), and on https the name starts with
 * `__Secure-`. The web app does not know the API's prefix, so it accepts any
 * prefix.
 */
const SESSION_TOKEN_COOKIE = /^(?:__Secure-|__Host-)?[^\s=;]+\.session_token$/

/**
 * True when the request carries a Better Auth session token cookie with a
 * value. It does not prove that the session is valid: the API checks every
 * request, and the dashboard sends a signed-out person to the login page when
 * the API does not know the session.
 */
export function hasSessionTokenCookie(cookieHeader: string | null | undefined): boolean {
  if (!cookieHeader) return false
  return cookieHeader.split(";").some((pair) => {
    const separator = pair.indexOf("=")
    if (separator < 0) return false
    const name = pair.slice(0, separator).trim()
    const value = pair.slice(separator + 1).trim()
    return value.length > 0 && SESSION_TOKEN_COOKIE.test(name)
  })
}

/**
 * Better Auth's session cache cookie, `{prefix}.session_data`. A long value is
 * split into `{name}.0`, `{name}.1`, and so on.
 */
const SESSION_DATA_COOKIE = /^((?:__Secure-|__Host-)?[^\s=;]+\.session_data)(?:\.(\d+))?$/

/** The person that the session cache cookie names. */
export interface SessionCookieIdentity {
  id: string
  email: string | null
}

/**
 * Reads the signed-in person from Better Auth's session cache cookie, so the
 * server render can show their email at once. The cookie uses the "compact"
 * strategy (`packages/auth/src/server.ts`): base64url JSON of
 * `{ session: { session, user }, expiresAt, signature }`.
 *
 * FOR DISPLAY ONLY. The signature is not checked (the web app has no secret),
 * so the value must never decide access. The browser confirms the session
 * with the API right after, and the API checks every request.
 *
 * Returns null when the cookie is missing, expired or not readable.
 */
export function readSessionCookieIdentity(
  cookieHeader: string | null | undefined,
  now: number = Date.now(),
): SessionCookieIdentity | null {
  for (const value of sessionDataCookieValues(cookieHeader)) {
    const identity = identityFromSessionData(value, now)
    if (identity) return identity
  }
  return null
}

/** Each session cache cookie value in the header, with its chunks joined. */
function sessionDataCookieValues(cookieHeader: string | null | undefined): string[] {
  if (!cookieHeader) return []
  const whole = new Map<string, string>()
  const chunks = new Map<string, { index: number; value: string }[]>()
  for (const pair of cookieHeader.split(";")) {
    const separator = pair.indexOf("=")
    if (separator < 0) continue
    const match = SESSION_DATA_COOKIE.exec(pair.slice(0, separator).trim())
    const value = pair.slice(separator + 1).trim()
    if (!match || !value) continue
    const [, name, index] = match
    if (index === undefined) whole.set(name, value)
    else chunks.set(name, [...(chunks.get(name) ?? []), { index: Number(index), value }])
  }
  for (const [name, parts] of chunks) {
    if (whole.has(name)) continue
    whole.set(name, parts.sort((a, b) => a.index - b.index).map((part) => part.value).join(""))
  }
  return [...whole.values()]
}

function identityFromSessionData(value: string, now: number): SessionCookieIdentity | null {
  const payload = parseJson(decodeBase64Url(safeDecodeURIComponent(value)))
  if (!isRecord(payload)) return null
  if (typeof payload.expiresAt !== "number" || payload.expiresAt <= now) return null
  const cached = payload.session
  if (!isRecord(cached) || !isRecord(cached.user) || typeof cached.user.id !== "string") return null
  // The session itself can end before the cache does.
  const sessionExpiresAt = isRecord(cached.session) ? cached.session.expiresAt : undefined
  if (typeof sessionExpiresAt === "string" && !(new Date(sessionExpiresAt).getTime() > now)) return null
  const email = cached.user.email
  return { id: cached.user.id, email: typeof email === "string" ? email : null }
}

function decodeBase64Url(value: string): string | null {
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/")
    const binary = atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "="))
    return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))
  } catch {
    return null
  }
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function parseJson(text: string | null): unknown {
  if (text === null) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
