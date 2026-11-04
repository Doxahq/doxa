import { createServerFn } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"

import { looksSignedIn } from "~/lib/auth/session-cookie"

/** What the marketing nav needs to know about the visitor. */
export interface MarketingViewer {
  /**
   * The request carries the signed-in marker or a session cookie. FOR DISPLAY
   * ONLY: the cookie is not verified, and the dashboard sends a person with an unknown session to the
   * login page.
   */
  signedIn: boolean
}

/**
 * Reads only the request cookies, so the page never waits for the API. A
 * prerender has no cookies, so the static pages are the signed-out version.
 */
export const getMarketingViewer = createServerFn({ method: "GET" }).handler(
  async (): Promise<MarketingViewer> => ({
    signedIn: looksSignedIn(getRequest().headers.get("cookie")),
  }),
)
