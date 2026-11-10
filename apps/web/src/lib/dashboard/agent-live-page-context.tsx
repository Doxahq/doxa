import { createContext, useContext, type ReactNode } from "react"

const AgentLivePageContext = createContext<string | null>(null)

/** Tells the rows of the page tree which page an active agent works on. */
export function AgentLivePageProvider({ href, children }: { href: string | null; children: ReactNode }) {
  return <AgentLivePageContext.Provider value={href}>{children}</AgentLivePageContext.Provider>
}

export function useIsAgentLivePage(href: string): boolean {
  return useContext(AgentLivePageContext) === href
}
