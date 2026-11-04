/**
 * Better Auth names its session cookie `{prefix}.session_token`, and on https
 * the name starts with `__Secure-`. The prefix is `better-auth` unless the API
 * sets `AUTH_COOKIE_PREFIX` (for example `doxa-dev` in local development). Set
 * `VITE_AUTH_COOKIE_PREFIX` to the same value.
 *
 * Only cookies with this prefix count: a dev host such as `dev.doxa.so` also
 * receives the production `.doxa.so` cookies, and those must not make a person
 * who signed out of dev look signed in. `worker.js` has no `import.meta.env`,
 * so it uses the production prefix.
 */
export const AUTH_COOKIE_PREFIX: string = import.meta.env?.VITE_AUTH_COOKIE_PREFIX || "better-auth"

/** The name of the cookie `{prefix}.{suffix}`, with or without `__Secure-` / `__Host-`. */
function authCookieName(prefix: string, suffix: string): string {
  return `^(?:__Secure-|__Host-)?${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.${suffix}`
}

/**
 * True when the request carries a Better Auth session token cookie with a
 * value. It does not prove that the session is valid: the API checks every
 * request, and the dashboard sends a signed-out person to the login page when
 * the API does not know the session.
 */
export function hasSessionTokenCookie(
  cookieHeader: string | null | undefined,
  prefix: string = AUTH_COOKIE_PREFIX,
): boolean {
  if (!cookieHeader) return false
  const sessionToken = new RegExp(`${authCookieName(prefix, "session_token")}$`)
  return cookieHeader.split(";").some((pair) => {
    const separator = pair.indexOf("=")
    if (separator < 0) return false
    const name = pair.slice(0, separator).trim()
    const value = pair.slice(separator + 1).trim()
    return value.length > 0 && sessionToken.test(name)
  })
}

/**
 * The API's signed-in marker, `{prefix}.signed_in=1` (SEC-021). The prefix is
 * the API's AUTH_COOKIE_PREFIX: "doxa" in production, where the API sets no
 * prefix and the marker has its own default. A development web app whose API
 * sets another prefix sets VITE_AUTH_COOKIE_PREFIX to match, so the production
 * marker on doxa.so never counts on dev.doxa.so.
 */
export const SIGNED_IN_COOKIE_NAME = `${import.meta.env?.VITE_AUTH_COOKIE_PREFIX || "doxa"}.signed_in`

/**
 * True when the request carries the API's signed-in marker. The session
 * cookies are host-only on the API host, so the dashboard server sees only
 * this marker. Like the token check, it does not prove a valid session.
 */
export function hasSignedInCookie(
  cookieHeader: string | null | undefined,
  name: string = SIGNED_IN_COOKIE_NAME,
): boolean {
  if (!cookieHeader) return false
  return cookieHeader.split(";").some((pair) => pair.trim() === `${name}=1`)
}

/**
 * True when the request looks signed in: the marker, or a session cookie from
 * before host-only cookies. FOR DISPLAY AND ROUTING ONLY: the API checks every
 * request, and the login page reads only the marker, so it cannot loop.
 */
export function looksSignedIn(cookieHeader: string | null | undefined): boolean {
  return hasSignedInCookie(cookieHeader) || hasSessionTokenCookie(cookieHeader)
}

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
  prefix: string = AUTH_COOKIE_PREFIX,
): SessionCookieIdentity | null {
  for (const value of sessionDataCookieValues(cookieHeader, prefix)) {
    const identity = identityFromSessionData(value, now)
    if (identity) return identity
  }
  return null
}

/**
 * Each session cache cookie (`{prefix}.session_data`) value in the header. A
 * long value is split into `{name}.0`, `{name}.1`, and so on: they are joined.
 */
function sessionDataCookieValues(cookieHeader: string | null | undefined, prefix: string): string[] {
  if (!cookieHeader) return []
  const sessionData = new RegExp(`(${authCookieName(prefix, "session_data")})(?:\\.(\\d+))?$`)
  const whole = new Map<string, string>()
  const chunks = new Map<string, { index: number; value: string }[]>()
  for (const pair of cookieHeader.split(";")) {
    const separator = pair.indexOf("=")
    if (separator < 0) continue
    const match = sessionData.exec(pair.slice(0, separator).trim())
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
