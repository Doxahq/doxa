import { authClient } from "@doxahq/auth/client"

import { DEFAULT_REDIRECT_PATH } from "~/lib/auth/safe-redirect"

export type SignInProvider = "google" | "github"

/**
 * Starts a social sign-in. `redirectPath` must be a safe same-origin path
 * (see `sanitizeRedirectPath`); the person lands there after sign-in.
 */
export async function signIn(
  provider: SignInProvider,
  redirectPath: string = DEFAULT_REDIRECT_PATH,
): Promise<void> {
  const callbackURL = `${window.location.origin}${redirectPath}`
  const { error } = await authClient.signIn.social({ provider, callbackURL })
  // The client returns a server error instead of throwing it. Throw it, so the
  // page stops waiting for a redirect that never comes.
  if (error) throw new Error(error.message || "Sign-in could not start.")
}

export async function signOut(): Promise<void> {
  await authClient.signOut()
}
