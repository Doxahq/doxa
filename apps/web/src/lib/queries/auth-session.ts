import { queryOptions } from "@tanstack/react-query"
import { authClient } from "@doxahq/auth/client"

import type { DashboardSessionUser } from "~/lib/auth/dashboard-session"
import { userAvatarUrl, userDisplayName, type UserPictureSource } from "~/lib/auth/user-profile"

export const authSessionQueryKeys = {
  session: () => ["auth", "session"] as const,
}

/** The signed-in person, or null when the API knows no session for this browser. */
export type AuthSessionUser = DashboardSessionUser | null

interface BetterAuthSessionUser extends UserPictureSource {
  id: string
  name?: string | null
  email?: string | null
}

/**
 * The person in the dashboard shell (status bar, account menu).
 *
 * It reads the Better Auth session, not `/me`: the id, the name, the email
 * and the avatar (see `userAvatarUrl`).
 */
export function toAuthSessionUser(user: BetterAuthSessionUser | null | undefined): AuthSessionUser {
  if (!user) return null
  return { id: user.id, name: userDisplayName(user.name), email: user.email ?? null, image: userAvatarUrl(user) }
}

/**
 * The Better Auth session of this browser. It stays the same for the whole
 * page load: signing out leaves the dashboard, and signing in reloads the page.
 */
export function authSessionQueryOptions() {
  return queryOptions({
    queryKey: authSessionQueryKeys.session(),
    queryFn: async (): Promise<AuthSessionUser> => {
      const { data, error } = await authClient.getSession()
      if (error) {
        if (error.status === 401) return null
        // Any other failure is not a signed-out answer. It throws, so the
        // shell does not send a signed-in person to the login page.
        throw new Error(error.message || "The session could not be loaded.")
      }
      return toAuthSessionUser(data?.user)
    },
    staleTime: Infinity,
  })
}
