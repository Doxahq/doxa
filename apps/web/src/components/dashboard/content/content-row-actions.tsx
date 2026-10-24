import type { ComponentProps, MouseEvent, ReactNode } from "react"
import { House, MoreHorizontal, Pencil, Plus, Settings2, Trash2 } from "lucide-react"

import { Button } from "~/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip"
import { cn } from "~/lib/utils"

/**
 * Menu metrics taken from the rows the menu belongs to.
 *
 * A section row is 31px tall and a page title is 12px, so the stock menu at
 * 32px and 14px reads as a control from another screen. The menu is portaled
 * to the body, which sits outside the `font-sans` root of the dashboard, so it
 * also has to name its own family or it falls back to the marketing mono.
 */
const MENU_CONTENT_CLASS = "min-w-32 p-0.5 font-sans"
const MENU_ITEM_CLASS = "gap-2 px-2 py-1.5 text-xs [&_svg]:size-3.5"

interface ContentRowAction {
  label: string
  onClick: () => void
}

interface ContentRowActionsProps {
  /**
   * Names the row inside every label, for example `the section Docs`.
   *
   * The menu items read "Edit" and "Delete", so the name of the row lives on
   * the trigger. A screen reader then hears which row the menu belongs to.
   */
  target: string
  onRename: () => void
  onDelete: () => void
  /** Explains why delete is unavailable. Null keeps the delete action enabled. */
  deleteDisabledReason: string | null
  /**
   * The one thing this row can create.
   *
   * A row owns a single create action, so its position names the action. A
   * section adds a group, and a group adds a page. Two identical buttons on one
   * row would carry no meaning.
   */
  createAction?: ContentRowAction
  /**
   * "Set as default page", for a page row: the page that the site root shows.
   * The item stays in the menu on the default page, disabled, so the menu
   * keeps its shape and says why there is nothing to do.
   */
  defaultAction?: { isDefault: boolean; onSelect: () => void }
  /** "Page settings", for a page row. */
  onOpenPageSettings?: () => void
  disabled?: boolean
}

/**
 * Row actions: one button that creates, and one menu that edits or deletes.
 *
 * Edit and delete share a menu because both act on the row itself, and because
 * a delete must not sit one stray click away from a rename.
 */
export function ContentRowActions({
  target,
  onRename,
  onDelete,
  deleteDisabledReason,
  createAction,
  defaultAction,
  onOpenPageSettings,
  disabled = false,
}: ContentRowActionsProps) {
  const run = (event: MouseEvent<HTMLButtonElement>, action: () => void) => {
    event.stopPropagation()
    action()
  }

  return (
    <span className="flex shrink-0 items-center gap-0.5">
      {createAction ? (
        <RowActionButton
          label={createAction.label}
          disabled={disabled}
          onClick={(event) => run(event, createAction.onClick)}
        >
          <Plus aria-hidden="true" className="size-3" />
        </RowActionButton>
      ) : null}
      {/*
        A modal menu sets `pointer-events: none` on the body while it is open.
        Choosing Edit or Delete opens a dialog, and that dialog records the body
        style as it finds it. It finds the menu's lock, and it restores that
        lock when it closes, which leaves the whole page unclickable. A menu
        that is not modal never sets the style, so there is nothing to inherit.
      */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <RowActionButton
            label={`Actions for ${target}`}
            disabled={disabled}
            aria-description={deleteDisabledReason ?? undefined}
            onClick={(event) => event.stopPropagation()}
          >
            <MoreHorizontal aria-hidden="true" className="size-3" />
          </RowActionButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className={MENU_CONTENT_CLASS}>
          <DropdownMenuItem onSelect={onRename} className={MENU_ITEM_CLASS}>
            <Pencil aria-hidden="true" />
            Edit
          </DropdownMenuItem>
          {defaultAction ? (
            <DropdownMenuItem
              disabled={defaultAction.isDefault}
              onSelect={defaultAction.onSelect}
              className={MENU_ITEM_CLASS}
            >
              <House aria-hidden="true" />
              {defaultAction.isDefault ? "Default page" : "Set as default page"}
            </DropdownMenuItem>
          ) : null}
          {onOpenPageSettings ? (
            <DropdownMenuItem onSelect={onOpenPageSettings} className={MENU_ITEM_CLASS}>
              <Settings2 aria-hidden="true" />
              Page settings
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator className="-mx-0.5 my-0.5" />
          <DeleteMenuItem
            disabledReason={deleteDisabledReason}
            onDelete={onDelete}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  )
}

interface DeleteMenuItemProps {
  disabledReason: string | null
  onDelete: () => void
}

/** The destructive menu action, with an explanation when the server forbids it. */
function DeleteMenuItem({ disabledReason, onDelete }: DeleteMenuItemProps) {
  const item = (
    <DropdownMenuItem
      disabled={disabledReason !== null}
      onSelect={onDelete}
      title={disabledReason ?? undefined}
      aria-label={
        disabledReason ? `Delete unavailable. ${disabledReason}` : undefined
      }
      className={cn(
        MENU_ITEM_CLASS,
        "text-destructive focus:bg-destructive/10 focus:text-destructive",
        disabledReason &&
          "data-[disabled]:pointer-events-auto data-[disabled]:cursor-not-allowed",
      )}
    >
      <Trash2 aria-hidden="true" />
      Delete
    </DropdownMenuItem>
  )

  if (!disabledReason) return item

  return (
    <Tooltip>
      <TooltipTrigger asChild>{item}</TooltipTrigger>
      <TooltipContent side="left" className="max-w-52 text-xs">
        {disabledReason}
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * Extra props reach this button through `asChild` on the menu trigger, which
 * clones the element and passes its own handlers and state attributes.
 */
type RowActionButtonProps = ComponentProps<typeof Button> & {
  label: string
  disabled: boolean
  onClick: (event: MouseEvent<HTMLButtonElement>) => void
  children: ReactNode
}

/**
 * One row action.
 *
 * The button always mounts, and only its opacity changes. A button that mounts
 * on hover is unreachable by keyboard.
 */
function RowActionButton({ label, disabled, onClick, children, ...props }: RowActionButtonProps) {
  return (
    <Button
      {...props}
      type="button"
      variant="ghost"
      size="icon"
      disabled={disabled}
      aria-label={label}
      className="size-6 opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
      onClick={onClick}
    >
      {children}
    </Button>
  )
}
