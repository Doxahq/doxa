import { authClient } from "@doxahq/auth/client"

import { SIGN_IN_UNAVAILABLE_ERROR } from "~/lib/auth/sign-in-link"

export { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@doxahq/auth/client"

/** The outcome of an email and password request: done, or a message to show. */
export type AuthResult = { ok: true } | { ok: false; code: string | null; message: string }

/**
 * The page a verification link returns to. The link signs the person in, and
 * `/login` then sends them on to `redirectPath`. A bad link comes back to
 * `/login` with `error=INVALID_TOKEN` (or `TOKEN_EXPIRED`), which the page shows.
 */
function verificationCallbackURL(redirectPath: string): string {
  const query = new URLSearchParams({ redirect: redirectPath })
  return `${window.location.origin}/login?${query}`
}

/** Creates an account. The person must open the verification link before they can sign in. */
export async function signUpWithEmail(input: {
  name: string
  email: string
  password: string
  redirectPath: string
}): Promise<AuthResult> {
  const { error } = await authClient.signUp.email({
    name: input.name,
    email: input.email,
    password: input.password,
    callbackURL: verificationCallbackURL(input.redirectPath),
  })
  return error ? failure(error) : { ok: true }
}

/** Signs in. An unverified account gets `EMAIL_NOT_VERIFIED`, and the API sends a new link. */
export async function signInWithEmail(input: {
  email: string
  password: string
  redirectPath: string
}): Promise<AuthResult> {
  const { error } = await authClient.signIn.email({
    email: input.email,
    password: input.password,
    callbackURL: verificationCallbackURL(input.redirectPath),
  })
  return error ? failure(error) : { ok: true }
}

/** Sends a reset link when the address has an account. The answer is the same either way. */
export async function requestPasswordReset(email: string): Promise<AuthResult> {
  const { error } = await authClient.requestPasswordReset({
    email,
    redirectTo: `${window.location.origin}/reset-password`,
  })
  return error ? failure(error) : { ok: true }
}

/** Sets a new password with the token from a reset link. The API signs out every other session. */
export async function resetPassword(token: string, newPassword: string): Promise<AuthResult> {
  const { error } = await authClient.resetPassword({ token, newPassword })
  return error ? failure(error) : { ok: true }
}

const MESSAGES: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: "Wrong email or password.",
  INVALID_EMAIL: "Enter a valid email address.",
  INVALID_PASSWORD: "Wrong email or password.",
  PASSWORD_TOO_SHORT: "The password is too short.",
  PASSWORD_TOO_LONG: "The password is too long.",
  EMAIL_NOT_VERIFIED: "Verify your email first. We sent a new link to your inbox.",
  INVALID_TOKEN: "This link is not valid anymore. Ask for a new one.",
  TOKEN_EXPIRED: "This link expired. Ask for a new one.",
}

function failure(error: { code?: string; message?: string; status: number }): AuthResult {
  const code = error.code ?? null
  if (error.status === 429) {
    return { ok: false, code, message: "Too many attempts. Wait a minute, then try again." }
  }
  return { ok: false, code, message: (code && MESSAGES[code]) || "Something went wrong. Try again." }
}

/**
 * Messages for the `error` that the API puts on `/login`: a social sign-in
 * that could not start or finish, or a verification link that did not work.
 */
export function loginErrorMessage(error: string | undefined): string | null {
  switch (error) {
    case undefined:
      return null
    case SIGN_IN_UNAVAILABLE_ERROR:
      return "Sign-in is not available right now. Try again later or use another option."
    case "account_not_linked":
      return "This email already has a Doxa account that is not verified. Sign in with your email and password to get a new verification link."
    case "INVALID_TOKEN":
    case "TOKEN_EXPIRED":
    case "USER_NOT_FOUND":
      return "This verification link is not valid anymore. Sign in with your email and password to get a new one."
    default:
      return "Sign-in did not finish. Try again."
  }
}
