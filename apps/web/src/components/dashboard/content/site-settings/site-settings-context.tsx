import { createContext, useContext, type ReactNode } from "react"

import type { SiteSettingsState } from "~/lib/dashboard/use-site-settings"

interface SiteSettingsContextValue {
  projectId: string
  state: SiteSettingsState
  /** True for a role without `site.write`: the fields show, nothing changes. */
  readOnly: boolean
}

const SiteSettingsContext = createContext<SiteSettingsContextValue | null>(null)

export function SiteSettingsProvider({
  projectId,
  state,
  readOnly = false,
  children,
}: Omit<SiteSettingsContextValue, "readOnly"> & { readOnly?: boolean; children: ReactNode }) {
  return (
    <SiteSettingsContext.Provider value={{ projectId, state, readOnly }}>{children}</SiteSettingsContext.Provider>
  )
}

/** The settings state for the fields inside the dialog. */
export function useSiteSettingsContext(): SiteSettingsContextValue {
  const context = useContext(SiteSettingsContext)
  if (!context) throw new Error("Site settings fields must render inside SiteSettingsProvider.")
  return context
}
