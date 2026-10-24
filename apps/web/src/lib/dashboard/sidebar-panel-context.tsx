import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"

interface SidebarPanelContextValue {
  panel: ReactNode | null
  setPanel: (panel: ReactNode | null) => void
}

const SidebarPanelContext = createContext<SidebarPanelContextValue | null>(null)

/**
 * Lets the content route fill the sidebar's Content view.
 *
 * The editor state lives in the content route, so the branch switcher and the
 * page list it drives are rendered there and shown in the sidebar through
 * this slot.
 */
export function SidebarPanelProvider({ children }: { children: ReactNode }) {
  const [panel, setPanel] = useState<ReactNode | null>(null)
  const value = useMemo(() => ({ panel, setPanel }), [panel])

  return (
    <SidebarPanelContext.Provider value={value}>{children}</SidebarPanelContext.Provider>
  )
}

export function useSidebarPanelSlot(): ReactNode | null {
  return useContext(SidebarPanelContext)?.panel ?? null
}

/**
 * Publishes a panel for as long as the calling component is mounted.
 *
 * Memoize the panel in the caller. An unstable node re-renders the sidebar on
 * every keystroke of the editor.
 */
export function useSidebarPanel(node: ReactNode | null): void {
  const context = useContext(SidebarPanelContext)
  const setPanel = context?.setPanel
  const clear = useCallback(() => setPanel?.(null), [setPanel])

  // A layout effect, so the panel shows in the same paint as the page that
  // publishes it. The content editor relies on this to swap the sidebar
  // skeleton and the body skeleton for the real screen at once.
  useLayoutEffect(() => {
    if (!setPanel) return
    setPanel(node)
    return clear
  }, [clear, node, setPanel])
}
