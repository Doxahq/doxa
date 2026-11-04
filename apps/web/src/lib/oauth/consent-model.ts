import {
  MAX_GRANT_PROJECT_IDS,
  OAUTH_SCOPE_IMPLICATIONS,
  OAUTH_SCOPES,
  type ApproveAgentConsentInput,
  type OAuthScope,
} from "@doxahq/contracts/agent-access"

/** What each scope lets an agent do, as a plain sentence for the consent page. */
export const OAUTH_SCOPE_SENTENCES: Record<OAuthScope, string> = {
  "projects:read": "See your projects, domains, and generations.",
  "projects:write": "Create and delete projects.",
  "docs:read": "Read your pages, structure, site settings, branches, and history.",
  "docs:write": "Create branches and edit pages, structure, and images.",
  "site:write": "Change site settings on a branch.",
  "domains:write": "Add, check, and remove custom domains.",
  publish: "Publish branches and restore earlier versions.",
  "generation:run": "Start and cancel docs generations.",
}

/**
 * The scopes the page offers, in the standard order. A client that asks for
 * no scopes gets the read scopes only, as the API offers (SEC-013).
 */
export function offeredScopes(requested: readonly OAuthScope[]): OAuthScope[] {
  if (requested.length === 0) return OAUTH_SCOPES.filter(isReadScope)
  const wanted = new Set(requested)
  return OAUTH_SCOPES.filter((scope) => wanted.has(scope))
}

/** A scope that only reads. */
export function isReadScope(scope: OAuthScope): boolean {
  return scope.endsWith(":read")
}

/**
 * The scopes checked when the page opens: the read scopes only. The person
 * checks each write scope on purpose (SEC-013).
 */
export function initialScopes(offered: readonly OAuthScope[]): Set<OAuthScope> {
  return new Set(offered.filter(isReadScope))
}

/**
 * The project choice when the page opens (SEC-013): selected projects, never
 * all. A person with one project gets it selected. A person with no project
 * can only allow all, which also covers the projects the agent creates.
 */
export function initialProjectChoice(projectIds: readonly string[]): ProjectChoice {
  if (projectIds.length === 0) return { kind: "all" }
  return { kind: "selected", projectIds: new Set(projectIds.length === 1 ? projectIds : []) }
}

/** Every scope that the chosen scopes imply, directly or through another scope. */
export function impliedScopes(chosen: Iterable<OAuthScope>): Set<OAuthScope> {
  const implied = new Set<OAuthScope>()
  const queue: OAuthScope[] = [...chosen]

  for (let scope = queue.pop(); scope !== undefined; scope = queue.pop()) {
    for (const next of OAUTH_SCOPE_IMPLICATIONS[scope]) {
      if (!implied.has(next)) {
        implied.add(next)
        queue.push(next)
      }
    }
  }

  return implied
}

export interface ScopeOption {
  scope: OAuthScope
  sentence: string
  checked: boolean
  /** Another checked scope needs this one, so the person cannot clear it. */
  required: boolean
}

export function scopeOptions(
  offered: readonly OAuthScope[],
  chosen: ReadonlySet<OAuthScope>,
): ScopeOption[] {
  const implied = impliedScopes(chosen)
  return offered.map((scope) => ({
    scope,
    sentence: OAUTH_SCOPE_SENTENCES[scope],
    checked: chosen.has(scope) || implied.has(scope),
    required: implied.has(scope),
  }))
}

/**
 * The scopes to approve: the chosen ones plus the offered scopes they imply.
 * An implied scope the client did not ask for is left out, because the API
 * accepts only requested scopes and adds implied ones itself.
 */
export function effectiveScopes(
  offered: readonly OAuthScope[],
  chosen: ReadonlySet<OAuthScope>,
): OAuthScope[] {
  return scopeOptions(offered, chosen)
    .filter((option) => option.checked)
    .map((option) => option.scope)
}

export type ProjectChoice =
  | { kind: "all" }
  | { kind: "selected"; projectIds: ReadonlySet<string> }

/** Why the project choice cannot be approved, or null when it is valid. */
export function projectChoiceIssue(choice: ProjectChoice): string | null {
  if (choice.kind === "all") return null
  if (choice.projectIds.size === 0) return "Choose at least one project."
  if (choice.projectIds.size > MAX_GRANT_PROJECT_IDS) {
    return `Choose ${MAX_GRANT_PROJECT_IDS} projects or fewer, or allow all projects.`
  }
  return null
}

/** The approve request body, or null while the choices are not valid. */
export function buildApproveInput(
  offered: readonly OAuthScope[],
  chosen: ReadonlySet<OAuthScope>,
  projectChoice: ProjectChoice,
): ApproveAgentConsentInput | null {
  const scopes = effectiveScopes(offered, chosen)
  if (scopes.length === 0 || projectChoiceIssue(projectChoice) !== null) return null

  return {
    scopes,
    projectScope: projectChoice.kind === "all"
      ? { kind: "all" }
      : { kind: "selected", projectIds: [...projectChoice.projectIds] },
  }
}

const UNSAFE_REDIRECT_PROTOCOLS: ReadonlySet<string> = new Set([
  "javascript:",
  "data:",
  "vbscript:",
  "blob:",
  "file:",
])

/**
 * True when the browser may open the redirect the API returned. The API
 * builds it from a registered redirect URI; this is a second check (SEC-034):
 * the browser goes only where the page told the person it goes
 * (`redirectHost`), and never to a script URL.
 *
 * `redirectHost` is the host of the registered URI, or the whole URI for a
 * native app scheme without a host (see `describeConsentClient`).
 */
export function isNavigableRedirect(value: string, redirectHost: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (UNSAFE_REDIRECT_PROTOCOLS.has(url.protocol) || redirectHost.length === 0) return false
  if (url.host) return url.host === redirectHost
  return value.startsWith(redirectHost)
}
