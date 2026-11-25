import { useEffect, useRef, useState, type ReactNode } from "react"
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu"
import { Link } from "@tanstack/react-router"
import { Check, ChevronDown, CreditCard, Plus, UserPlus, Users } from "lucide-react"

import { LogoWordmark } from "~/components/navigation/logo"
import { MenuSectionLabel } from "~/components/dashboard/shell/menu-parts"
import { WorkspaceMenuTip } from "~/components/dashboard/shell/workspace-menu-tip"
import { WorkspaceTile } from "~/components/dashboard/shell/workspace-tile"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu"
import { Skeleton } from "~/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip"
import { TEAM_INVITES_ANCHOR } from "~/lib/dashboard/teams-model"
import { useWorkspace } from "~/lib/dashboard/workspace-context"
import {
  canCreateProjectIn,
  canManageMembersOf,
  canReadBillingOf,
  workspaceSummary,
  type Workspace,
} from "~/lib/dashboard/workspace-model"

const MENU_HINT = "Workspaces, new project, billing"
const MENU_WIDTH_PX = 288

/**
 * The Doxa logo in the sidebar header. It opens the workspace menu: switch
 * between Personal and the teams, create a team, and the actions of the
 * current workspace (New project, Invite members, Billing). A small chevron
 * is the hint that the logo opens something; the label on hover says what.
 */
export function WorkspaceMenu() {
  const { isMenuOpen, setMenuOpen } = useWorkspace()
  const { hint, menuFocus } = useLogoFocus(isMenuOpen)

  return (
    <DropdownMenu open={isMenuOpen} onOpenChange={setMenuOpen}>
      <WorkspaceMenuTip>
        <Tooltip delayDuration={400} open={hint.open} onOpenChange={hint.onOpenChange}>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Workspace menu"
                className="group -ml-1 flex w-fit items-center gap-1.5 rounded-md py-1.5 pr-1.5 pl-2 transition-colors duration-100 ease-out hover:bg-overlay data-[state=open]:bg-overlay"
              >
                <LogoWordmark size={14} />
                <ChevronDown
                  aria-hidden="true"
                  className="size-3.5 text-faint transition-[color,rotate] duration-150 ease-out group-hover:text-muted-foreground group-data-[state=open]:rotate-180 group-data-[state=open]:text-foreground"
                />
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="right" className="px-2 py-1 text-xs">
            {MENU_HINT}
          </TooltipContent>
        </Tooltip>
      </WorkspaceMenuTip>
      <DropdownMenuContent align="start" sideOffset={6} style={{ width: MENU_WIDTH_PX }} {...menuFocus}>
        <WorkspaceMenuItems />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The focus of the logo around the menu, and its hover label.
 *
 * - A menu closed with the mouse leaves the logo unfocused. The focus would
 *   come from the menu items, which the browser counts as keyboard focus, so
 *   the logo would show the keyboard focus wash after a click.
 * - A menu closed with the keyboard gives the focus back to the logo, for the
 *   next key press. The label stays shut for that focus: it would only be noise.
 * - The label opens on hover and on keyboard focus, never over the open menu.
 */
function useLogoFocus(isMenuOpen: boolean) {
  const [isHintOpen, setHintOpen] = useState(false)
  const isClosingByPointer = useRef(false)
  const isFocusReturning = useRef(false)

  // A label opened before the menu (by keyboard focus) must not come back after it.
  useEffect(() => {
    if (isMenuOpen) setHintOpen(false)
  }, [isMenuOpen])

  return {
    hint: {
      open: isHintOpen && !isMenuOpen,
      onOpenChange(open: boolean) {
        if (open && isFocusReturning.current) return
        setHintOpen(open)
      },
    },
    menuFocus: {
      onPointerDown() {
        isClosingByPointer.current = true
      },
      onKeyDown() {
        isClosingByPointer.current = false
      },
      onCloseAutoFocus(event: Event) {
        const byPointer = isClosingByPointer.current
        isClosingByPointer.current = false
        if (byPointer) {
          event.preventDefault()
          return
        }
        // Radix focuses the logo in the same task, right after this event.
        isFocusReturning.current = true
        queueMicrotask(() => {
          isFocusReturning.current = false
        })
      },
    },
  }
}

function WorkspaceMenuItems() {
  const { current, workspaces, isTeamsPending, switchTo, preloadSwitch } = useWorkspace()

  return (
    <>
      <DropdownMenuLabel className="px-2 pt-2 pb-1">
        <MenuSectionLabel>Workspaces</MenuSectionLabel>
      </DropdownMenuLabel>
      <DropdownMenuPrimitive.RadioGroup value={current?.id ?? ""} onValueChange={switchTo}>
        {workspaces.map((workspace) => (
          <WorkspaceOption key={workspace.id} workspace={workspace} onPreload={() => preloadSwitch(workspace.id)} />
        ))}
      </DropdownMenuPrimitive.RadioGroup>
      {isTeamsPending ? <WorkspaceOptionSkeleton /> : null}
      <DropdownMenuItem asChild className="gap-2.5 text-muted-foreground">
        <Link to="/dashboard/teams">
          <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-[5px] border border-dashed border-border-strong">
            <Plus className="size-3.5" />
          </span>
          Create team
        </Link>
      </DropdownMenuItem>
      {current ? (
        <>
          <DropdownMenuSeparator />
          <CurrentWorkspaceItems workspace={current} />
        </>
      ) : null}
    </>
  )
}

function WorkspaceOption({ workspace, onPreload }: { workspace: Workspace; onPreload: () => void }) {
  return (
    <DropdownMenuPrimitive.RadioItem
      value={workspace.id}
      onPointerEnter={onPreload}
      onFocus={onPreload}
      className="relative flex cursor-default items-center gap-2.5 rounded-sm px-2 py-1.5 outline-none select-none focus:bg-overlay data-[state=checked]:bg-secondary"
    >
      <WorkspaceTile workspace={workspace} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-medium text-foreground">{workspace.name}</span>
        <span className="block truncate text-xs text-muted-foreground">{workspaceSummary(workspace)}</span>
      </span>
      <DropdownMenuPrimitive.ItemIndicator>
        <Check aria-hidden="true" className="size-4 text-primary-text" />
      </DropdownMenuPrimitive.ItemIndicator>
    </DropdownMenuPrimitive.RadioItem>
  )
}

/** A team row while the teams list loads, in the shape of a real row. */
function WorkspaceOptionSkeleton() {
  return (
    <div aria-hidden="true" className="flex items-center gap-2.5 px-2 py-1.5">
      <Skeleton className="size-7 rounded-[5px]" />
      <span className="flex flex-1 flex-col gap-1.5">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-2.5 w-36" />
      </span>
    </div>
  )
}

/** What the viewer's role can do in the current workspace. */
function CurrentWorkspaceItems({ workspace }: { workspace: Workspace }) {
  const teamId = workspace.teamId
  const canManageMembers = canManageMembersOf(workspace)
  const billingAccountId = workspace.billingAccount?.id ?? null

  return (
    <>
      <DropdownMenuLabel className="px-2 pt-2 pb-1">
        <MenuSectionLabel>{workspace.name}</MenuSectionLabel>
      </DropdownMenuLabel>
      {canCreateProjectIn(workspace) ? (
        <DropdownMenuItem asChild className={ACTION_ITEM_CLASS}>
          <Link to="/dashboard/projects/new">
            <ActionIcon>
              <Plus />
            </ActionIcon>
            New project
          </Link>
        </DropdownMenuItem>
      ) : null}
      {teamId !== null && workspace.role !== null ? (
        <DropdownMenuItem asChild className={ACTION_ITEM_CLASS}>
          <Link to="/dashboard/teams/$teamId" params={{ teamId }} hash={canManageMembers ? TEAM_INVITES_ANCHOR : undefined}>
            <ActionIcon>{canManageMembers ? <UserPlus /> : <Users />}</ActionIcon>
            {canManageMembers ? "Invite members" : "Members"}
          </Link>
        </DropdownMenuItem>
      ) : null}
      {canReadBillingOf(workspace) ? (
        <DropdownMenuItem asChild className={ACTION_ITEM_CLASS}>
          {billingAccountId ? (
            <Link to="/dashboard/billing/$accountId" params={{ accountId: billingAccountId }}>
              <ActionIcon>
                <CreditCard />
              </ActionIcon>
              Billing
            </Link>
          ) : (
            // The account list is still loading: the billing page opens this workspace's account.
            <Link to="/dashboard/billing">
              <ActionIcon>
                <CreditCard />
              </ActionIcon>
              Billing
            </Link>
          )}
        </DropdownMenuItem>
      ) : null}
    </>
  )
}

const ACTION_ITEM_CLASS = "gap-2.5 py-1 text-[13.5px]"

/** The icon of an action, in the tile column, so actions line up with the workspaces above. */
function ActionIcon({ children }: { children: ReactNode }) {
  return (
    <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center text-muted-foreground">
      {children}
    </span>
  )
}
