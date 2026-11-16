/** Which dialog the new project page opens on arrival. */
export type NewProjectStart = "repository" | "template"

export interface NewProjectSearch {
  start?: NewProjectStart
  /** The Checkout return of the Pro trial (billing spec 14.2): the session to sync. */
  checkout?: string
}

/**
 * Where the onboarding Pro trial's Checkout returns: this page, with the
 * repository dialog to open once the account has the Doxa Agent.
 */
export const NEW_PROJECT_TRIAL_RETURN_PATH = "/dashboard/projects/new?start=repository"

/**
 * `?start=repository` opens the "Generate from a repository" dialog, for
 * example when GitHub returns after the app install. `?start=template` opens
 * the starter or empty docs dialog. Any other value opens no dialog.
 * `?checkout=<id>` is the Checkout return of the Pro trial.
 */
export function parseNewProjectSearch(search: Record<string, unknown>): NewProjectSearch {
  const parsed: NewProjectSearch = {}
  if (search.start === "repository" || search.start === "template") parsed.start = search.start
  if (typeof search.checkout === "string" && search.checkout.length > 0) parsed.checkout = search.checkout
  return parsed
}
