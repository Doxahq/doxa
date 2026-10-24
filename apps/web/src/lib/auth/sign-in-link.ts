import type { SignInProvider } from "~/lib/auth/use-auth-session"
import { getApiUrl } from "~/lib/platform-api"

/** The `error` the API puts on `/login` when it cannot start a sign-in. */
export const SIGN_IN_UNAVAILABLE_ERROR = "sign-in-unavailable"

/**
 * The API link that starts a social sign-in (`GET /sign-in/:provider`). A
 * plain link works before the page hydrates. `redirectPath` must be a safe
 * same-origin path (see `sanitizeRedirectPath`).
 */
export function signInLink(provider: SignInProvider, redirectPath: string): string {
  const query = new URLSearchParams({ redirect: redirectPath })
  return getApiUrl(`/sign-in/${provider}?${query}`)
}
