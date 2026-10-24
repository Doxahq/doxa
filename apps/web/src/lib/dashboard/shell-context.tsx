import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { useNavigate, useRouterState } from "@tanstack/react-router"

import { useSidebar } from "~/components/ui/sidebar"
import { useRenderedPathname } from "~/lib/dashboard/use-rendered-pathname"

/** The sidebar views, in the order they slide: left to right. */
export const SIDEBAR_VIEWS = ["project", "content", "site"] as const
export type SidebarView = (typeof SIDEBAR_VIEWS)[number]

/** The view a route opens. The Content view can still be left for Project without leaving the editor. */
export function sidebarViewForPath(pathname: string): SidebarView {
  if (/^\/dashboard\/projects\/[^/]+\/content(?:\/|$)/.test(pathname)) return "content"
  // The changes of a pull request preview list their pages where the editor lists its pages.
  if (/^\/dashboard\/projects\/[^/]+\/generations\/[^/]+\/changes(?:\/|$)/.test(pathname)) return "content"
  if (/^\/dashboard\/projects\/[^/]+\/site(?:\/|$)/.test(pathname)) return "site"
  return "project"
}

interface SiteReturn {
  href: string
  view: SidebarView
}

interface ShellContextValue {
  view: SidebarView
  /** The view the last transition left. Only it and `view` animate. */
  previousView: SidebarView | null
  showView: (view: SidebarView) => void
  openSiteSettings: (projectId: string) => void
  closeSiteSettings: (projectId: string) => void
  focusMode: boolean
  toggleFocusMode: () => void
}

const ShellContext = createContext<ShellContextValue | null>(null)

/** Sidebar view, site settings return point, focus mode and "Go to" routing for the dashboard shell. */
export function ShellProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const locationHref = useRouterState({ select: (state) => state.location.href })
  // The sidebar follows the page on screen, not the URL, so it slides when the
  // page changes, not when the navigation starts.
  const pathname = useRenderedPathname()
  const sidebar = useSidebar()

  const [view, setView] = useState<SidebarView>(() => sidebarViewForPath(pathname))
  const [previousView, setPreviousView] = useState<SidebarView | null>(null)
  const pendingViewRef = useRef<SidebarView | null>(null)
  const siteReturnRef = useRef<SiteReturn | null>(null)

  const showView = useCallback((next: SidebarView) => {
    setView((current) => {
      if (current === next) return current
      setPreviousView(current)
      return next
    })
  }, [])

  // A route change moves the sidebar to the route's view, or to the view a
  // back action asked for. A layout effect, so the sidebar changes in the same
  // frame as the page.
  useLayoutEffect(() => {
    const next = pendingViewRef.current ?? sidebarViewForPath(pathname)
    pendingViewRef.current = null
    showView(next)
  }, [pathname, showView])

  const openSiteSettings = useCallback((projectId: string) => {
    if (sidebarViewForPath(pathname) !== "site") {
      siteReturnRef.current = { href: locationHref, view }
    }
    void navigate({ to: "/dashboard/projects/$projectId/site/appearance", params: { projectId } })
  }, [locationHref, navigate, pathname, view])

  const closeSiteSettings = useCallback((projectId: string) => {
    const target = siteReturnRef.current ?? {
      href: `/dashboard/projects/${projectId}/project`,
      view: "project" as const,
    }
    siteReturnRef.current = null
    pendingViewRef.current = target.view
    void navigate({ href: target.href })
  }, [navigate])

  // Focus mode hides the sidebar and remembers whether it was open.
  const [focusMode, setFocusMode] = useState(false)
  const sidebarWasOpenRef = useRef(true)
  const toggleFocusMode = useCallback(() => {
    if (focusMode) {
      sidebar.setOpen(sidebarWasOpenRef.current)
      setFocusMode(false)
      return
    }
    sidebarWasOpenRef.current = sidebar.open
    sidebar.setOpen(false)
    setFocusMode(true)
  }, [focusMode, sidebar])

  // Opening the sidebar by hand, or leaving the editor, ends focus mode.
  useEffect(() => {
    if (focusMode && (sidebar.open || view !== "content")) {
      if (view !== "content") sidebar.setOpen(sidebarWasOpenRef.current)
      setFocusMode(false)
    }
  }, [focusMode, sidebar, view])

  // Esc leaves site settings, unless a dialog or menu is open or the user is typing.
  useEffect(() => {
    if (view !== "site") return
    const projectId = /^\/dashboard\/projects\/([^/]+)/.exec(pathname)?.[1]
    if (!projectId) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return
      if (isEditableTarget(event.target) || hasOpenOverlay()) return
      closeSiteSettings(projectId)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [closeSiteSettings, pathname, view])

  const value = useMemo<ShellContextValue>(
    () => ({
      view,
      previousView,
      showView,
      openSiteSettings,
      closeSiteSettings,
      focusMode,
      toggleFocusMode,
    }),
    [
      closeSiteSettings,
      focusMode,
      openSiteSettings,
      previousView,
      showView,
      toggleFocusMode,
      view,
    ],
  )

  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>
}

export function useShell(): ShellContextValue {
  const shell = useContext(ShellContext)
  if (!shell) throw new Error("useShell must be used within ShellProvider")
  return shell
}

/** True when a key press belongs to a text field or an editor. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
}

/** True while a dialog, menu or popover is open. */
export function hasOpenOverlay(): boolean {
  return document.querySelector(
    '[role="dialog"][data-state="open"], [role="menu"][data-state="open"], [data-radix-popper-content-wrapper]',
  ) !== null
}
