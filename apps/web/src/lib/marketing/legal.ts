// Facts shared by the legal pages under /legal. Change a date here when the
// text of its document changes.

export const LEGAL_ENTITY = "CoderOne LLC"
export const LEGAL_BRAND = "CoderOne Labs"
export const LEGAL_LOCATION = "Concord, California, United States"

export type LegalDocId = "privacy" | "terms"

export interface LegalDocMeta {
  id: LegalDocId
  title: string
  /** The short name for tabs and cards. */
  label: string
  path: "/legal/privacy" | "/legal/terms"
  summary: string
  /** The date of the last change, shown as "Last updated". */
  updated: string
  effective: string
}

export const LEGAL_DOCS: Record<LegalDocId, LegalDocMeta> = {
  privacy: {
    id: "privacy",
    title: "Privacy Policy",
    label: "Privacy",
    path: "/legal/privacy",
    summary:
      "What Doxa collects, why we collect it, who processes it for us, and how you can see, export or delete it.",
    updated: "November 25, 2026",
    effective: "October 28, 2026",
  },
  terms: {
    id: "terms",
    title: "Terms of Service",
    label: "Terms",
    path: "/legal/terms",
    summary:
      "The agreement between you and CoderOne LLC for the hosted Doxa service: your content, AI output, acceptable use, plans, payments and liability.",
    updated: "November 25, 2026",
    effective: "October 28, 2026",
  },
}

export const LEGAL_DOC_ORDER: LegalDocId[] = ["terms", "privacy"]
