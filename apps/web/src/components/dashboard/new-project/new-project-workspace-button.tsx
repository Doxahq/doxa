import { ChevronDown } from "lucide-react"

import { WorkspaceTile } from "~/components/dashboard/shell/workspace-tile"
import { Button } from "~/components/ui/button"
import { useSidebar } from "~/components/ui/sidebar"
import { useWorkspace } from "~/lib/dashboard/workspace-context"

/**
 * "Creating in [CO] Coder One" in the top bar of the new project page: the
 * workspace that will own the project. A click opens the workspace menu.
 * A person with only the personal workspace has nothing to choose, so it
 * draws nothing.
 */
export function NewProjectWorkspaceButton() {
  const { current, workspaces, setMenuOpen } = useWorkspace()
  const sidebar = useSidebar()
  if (!current || workspaces.length < 2) return null

  // The menu hangs under the logo, so a closed sidebar opens first.
  function openMenu() {
    if (sidebar.isMobile) sidebar.setOpenMobile(true)
    else if (!sidebar.open) sidebar.setOpen(true)
    setMenuOpen(true)
  }

  return (
    <Button variant="outline" size="sm" onClick={openMenu} aria-label={`Creating in ${current.name}. Change workspace`}>
      <span className="text-muted-foreground">Creating in</span>
      <WorkspaceTile workspace={current} className="size-5 text-[9px]" />
      <span className="max-w-40 truncate">{current.name}</span>
      <ChevronDown aria-hidden="true" className="text-muted-foreground" />
    </Button>
  )
}
