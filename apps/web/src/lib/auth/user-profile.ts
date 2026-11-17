/** The name to show: the trimmed name, or null when it is empty or missing. */
export function userDisplayName(name: unknown): string | null {
  return typeof name === "string" && name.trim() !== "" ? name.trim() : null
}

/** What Better Auth keeps about a person's picture. */
export interface UserPictureSource {
  /** The picture of the provider the person signed up with (Google or GitHub). */
  image?: unknown
  /** Set when a GitHub account is linked (`packages/auth/src/github-identity.ts`). */
  githubLogin?: unknown
}

/** Twice the largest avatar in the dashboard (30px), for sharp edges on a retina screen. */
const GITHUB_AVATAR_SIZE_PX = 64

/** GitHub logins: letters, digits and single hyphens, at most 39 characters. */
const GITHUB_LOGIN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i

/**
 * The avatar to show for a person: their GitHub picture when a GitHub account
 * is linked, else the picture of the provider they signed up with, else null
 * (the avatar shows initials).
 */
export function userAvatarUrl(source: UserPictureSource): string | null {
  if (typeof source.githubLogin === "string" && GITHUB_LOGIN.test(source.githubLogin)) {
    return `https://avatars.githubusercontent.com/${source.githubLogin}?size=${GITHUB_AVATAR_SIZE_PX}`
  }
  return typeof source.image === "string" && isHttpsUrl(source.image) ? source.image : null
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:"
  } catch {
    return false
  }
}
