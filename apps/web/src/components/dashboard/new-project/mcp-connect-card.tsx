import { useRef, type ComponentPropsWithRef, type ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import { ArrowUpRight, Check, ChevronDown, Copy, FolderPlus, Globe, ListChecks, PenLine, Search, ShieldCheck } from "lucide-react"

import { SectionDescription, SectionLabel } from "~/components/dashboard/dashboard-header"
import { SnippetLines } from "~/components/mcp/snippet-lines"
import { Button } from "~/components/ui/button"
import { Popover, PopoverAnchor, PopoverContent } from "~/components/ui/popover"
import {
  ANY_CLIENT,
  MAIN_CLIENTS,
  isMoreClient,
  menuCountLabel,
  moreButtonText,
  moreStack,
  type McpClient,
} from "~/lib/mcp/clients"
import { useCopied } from "~/lib/mcp/copied"
import { clientOptionId, useClientMenuNavigation } from "~/lib/mcp/use-client-menu-navigation"
import { useMcpClientPicker, type McpClientPickerState } from "~/lib/mcp/use-client-picker"
import { cn } from "~/lib/utils"

const STACK = moreStack()
const LISTBOX_ID = "mcp-client-listbox"

/** Snippet token colors for the dashboard; the tones come from the shared snippet model. */
const SNIPPET_TONES = "[&_.t-k]:text-primary-text [&_.t-s]:text-foreground [&_.t-p]:text-label [&_.t-c]:text-label"

const CAPABILITIES = [
  {
    icon: FolderPlus,
    title: "Create and manage projects",
    description: "Start a project from the starter docs or an empty site, and change its settings.",
  },
  {
    icon: PenLine,
    title: "Write and edit pages",
    description: "Draft new pages and update old ones on a branch, in the same MDX as the editor.",
  },
  {
    icon: ListChecks,
    title: "Review changes",
    description: "Read the changes on a branch and check each page before it goes live.",
  },
  {
    icon: Globe,
    title: "Publish your docs",
    description: "Send a publish request. The site goes live when you approve it.",
  },
] as const

/**
 * "Connect your agent": the MCP setup for the chosen client and what the agent
 * can do. The clients, their snippets and the picker state are the ones the
 * MCP page uses (`lib/mcp`), so both stay the same.
 */
export function McpConnectCard({ insideDialog = false }: { insideDialog?: boolean }) {
  const copyState = useCopied()
  const picker = useMcpClientPicker(copyState.reset)
  const { active } = picker

  return (
    <section aria-labelledby="mcp-connect-title" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2.5">
          <SectionLabel>
            <span id="mcp-connect-title">Connect your agent</span>
          </SectionLabel>
          <span className="inline-flex h-5 items-center rounded-sm border border-primary/35 bg-primary-wash px-1.5 font-mono text-[10px] font-medium tracking-[0.14em] text-primary-text">
            MCP
          </span>
        </div>
        <SectionDescription>
          Add Doxa to your agent once. Then ask it to handle your docs, right from your editor or chat.
        </SectionDescription>
      </div>

      <div className="surface-card flex flex-col">
        <ClientTabs picker={picker} insideDialog={insideDialog} />

        <div className="flex flex-col gap-3 p-5">
          <div className="overflow-hidden rounded-md border border-border bg-code">
            <div className="flex h-[38px] items-center justify-between gap-3 border-b border-border pr-1.5 pl-3.5">
              <span className="truncate font-mono text-[11px] tracking-[0.04em] text-label">{active.file}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7"
                aria-label={`Copy setup for ${active.label}`}
                onClick={() => copyState.copy(active.snippet.copy, "snippet")}
              >
                {copyState.copied === "snippet" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                {copyState.copied === "snippet" ? "Copied" : active.copyLabel}
              </Button>
            </div>
            <pre
              className={cn(
                "overflow-x-auto px-4 py-3.5 font-mono text-[12.5px] leading-5 whitespace-pre text-body scrollbar-subtle",
                SNIPPET_TONES,
              )}
            >
              <SnippetLines lines={active.snippet.lines} />
            </pre>
          </div>
          <p className="text-[13px] leading-5 text-muted-foreground">{active.signIn}</p>
        </div>

        <ul className="grid border-t border-divider sm:grid-cols-2">
          {CAPABILITIES.map(({ icon: Icon, title, description }, index) => (
            <li
              key={title}
              className={cn(
                "flex gap-3 px-5 py-4",
                index > 0 && "border-t border-divider",
                index === 1 && "sm:border-t-0",
                index % 2 === 1 && "sm:border-l",
              )}
            >
              <span
                aria-hidden="true"
                className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface-hover text-body"
              >
                <Icon className="size-4" />
              </span>
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-semibold text-foreground">{title}</span>
                <span className="text-[13px] leading-5 text-muted-foreground">{description}</span>
              </span>
            </li>
          ))}
        </ul>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-b-[inherit] border-t border-divider bg-sidebar px-5 py-3">
          <span className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <ShieldCheck aria-hidden="true" className="size-4 shrink-0 text-success" />
            Your agent asks before it publishes, restores or deletes. You approve each request here.
          </span>
          <Link to="/mcp" className="inline-flex items-center gap-1 text-[13px] font-medium text-primary-text hover:underline">
            All clients and setup steps
            <ArrowUpRight aria-hidden="true" className="size-3.5" />
          </Link>
        </div>
      </div>
    </section>
  )
}

/** The five client tabs and the "More clients" tab with its menu. */
function ClientTabs({ picker, insideDialog }: { picker: McpClientPickerState; insideDialog: boolean }) {
  const { active, menuOpen } = picker
  const inMore = isMoreClient(active.id)
  const more = moreButtonText(active)
  const moreRef = useRef<HTMLButtonElement>(null)

  return (
    // The menu renders outside a surrounding dialog, and the scroll lock of that
    // dialog blocks the wheel there. A modal popover takes over the lock.
    <Popover modal={insideDialog} open={menuOpen} onOpenChange={(open) => (open ? undefined : picker.closeMenu())}>
      <PopoverAnchor asChild>
        <div role="group" aria-label="MCP client" className="flex flex-wrap gap-0.5 border-b border-divider px-3">
          {MAIN_CLIENTS.map((client) => (
            <ClientTab key={client.id} selected={client.id === active.id} onClick={() => picker.pick(client)}>
              <ClientMark client={client} />
              {client.label}
            </ClientTab>
          ))}
          <ClientTab
            ref={moreRef}
            selected={inMore}
            highlighted={menuOpen}
            aria-haspopup="dialog"
            aria-expanded={menuOpen}
            onClick={picker.toggleMenu}
          >
            {inMore ? (
              <ClientMark client={active} />
            ) : (
              <span aria-hidden="true" className="flex">
                {STACK.logos.map((src) => (
                  <span
                    key={src}
                    className="-ml-1.5 flex size-5 items-center justify-center rounded-full border border-border bg-surface-hover first:ml-0"
                  >
                    <img src={src} alt="" width={12} height={12} className="size-3" />
                  </span>
                ))}
                <span className="-ml-1.5 flex size-5 items-center justify-center rounded-full border border-border bg-surface-hover font-mono text-[9px] text-muted-foreground">
                  {STACK.count}
                </span>
              </span>
            )}
            {inMore ? active.label : more.label}
            <ChevronDown aria-hidden="true" className={cn("size-3.5 text-label transition-transform", menuOpen && "rotate-180")} />
          </ClientTab>
        </div>
      </PopoverAnchor>
      <PopoverContent
        aria-label="More MCP clients"
        className="w-(--radix-popover-trigger-width) max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg p-0"
        // The "More clients" tab toggles the menu itself, so a press on it is
        // not an outside click. Focus goes back to it when the menu closes.
        onInteractOutside={(event) => {
          if (moreRef.current?.contains(event.target as Node)) event.preventDefault()
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          moreRef.current?.focus()
        }}
      >
        <ClientMenu activeId={active.id} onPick={picker.pick} />
      </PopoverContent>
    </Popover>
  )
}

function ClientTab({
  selected,
  highlighted = false,
  children,
  ...props
}: {
  selected: boolean
  highlighted?: boolean
  children: ReactNode
} & Omit<ComponentPropsWithRef<"button">, "children" | "type">) {
  return (
    <button
      type="button"
      aria-pressed={props["aria-haspopup"] ? undefined : selected}
      className={cn(
        "-mb-px inline-flex h-11 items-center gap-2 rounded-t-md border-b-2 px-3 text-[13px] font-medium transition-colors hover:bg-surface-hover focus-visible:-outline-offset-2",
        selected ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
        highlighted && "text-foreground",
      )}
      {...props}
    >
      {children}
    </button>
  )
}

/** A client logo, or its letters in a tile when it has none. */
function ClientMark({ client }: { client: Pick<McpClient, "logo" | "mono"> }) {
  return client.logo ? (
    <img src={client.logo} alt="" width={16} height={16} className="size-4 shrink-0" />
  ) : (
    <span
      aria-hidden="true"
      className="flex size-4 shrink-0 items-center justify-center rounded-sm bg-border font-mono text-[10px] font-bold text-foreground"
    >
      {client.mono}
    </span>
  )
}

/**
 * Search, the clients behind "More clients" by group, and the server URL
 * fallback. The search box is a combobox: Up and Down move the highlight,
 * Enter picks it, Escape closes the menu.
 */
function ClientMenu({ activeId, onPick }: { activeId: string; onPick: (client: McpClient) => void }) {
  const menu = useClientMenuNavigation({ activeId, onPick })

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2.5 border-b border-menu-border p-2.5">
        <label className="flex h-9 flex-1 items-center gap-2 rounded-md border border-input bg-input-background px-2.5 text-label focus-within:border-ring">
          <Search aria-hidden="true" className="size-3.5" />
          <input
            type="search"
            role="combobox"
            aria-expanded="true"
            aria-controls={LISTBOX_ID}
            aria-autocomplete="list"
            aria-activedescendant={menu.highlightedId ? clientOptionId(menu.highlightedId) : undefined}
            value={menu.query}
            onChange={(event) => menu.setQuery(event.target.value)}
            onKeyDown={menu.onSearchKeyDown}
            placeholder="Search clients"
            aria-label="Search clients"
            autoComplete="off"
            autoFocus
            className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-label"
          />
        </label>
        <span className="font-mono text-[11px] tracking-[0.12em] whitespace-nowrap text-label uppercase max-sm:hidden">
          {menuCountLabel(menu.query, menu.shown)}
        </span>
      </div>
      <div
        id={LISTBOX_ID}
        role="listbox"
        aria-label="MCP clients"
        className="grid max-h-[360px] overflow-y-auto scrollbar-subtle sm:grid-cols-3"
      >
        {menu.groups.map((group) => (
          <div
            key={group.key}
            role="group"
            aria-labelledby={`mcp-client-group-${group.key}`}
            className="flex flex-col gap-0.5 px-2 py-3"
          >
            <span
              id={`mcp-client-group-${group.key}`}
              className="px-2 pb-1.5 font-mono text-[10px] tracking-[0.14em] text-label uppercase"
            >
              {group.name}
            </span>
            {group.clients.map((client) => {
              const selected = client.id === activeId
              const highlighted = client.id === menu.highlightedId
              return (
                // Options are not tab stops: focus stays in the search box,
                // which points at the highlighted option.
                <div
                  key={client.id}
                  id={clientOptionId(client.id)}
                  role="option"
                  aria-selected={highlighted}
                  aria-current={selected ? "true" : undefined}
                  onClick={() => onPick(client)}
                  onMouseMove={() => menu.highlight(client.id)}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left",
                    selected && highlighted && "bg-primary/15",
                    selected && !highlighted && "bg-primary-wash",
                    !selected && highlighted && "bg-overlay",
                  )}
                >
                  <ClientMark client={client} />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-[13px] font-medium text-foreground">{client.label}</span>
                    <span className="truncate text-xs text-label">{client.how}</span>
                  </span>
                </div>
              )
            })}
          </div>
        ))}
        {menu.shown === 0 ? (
          <p className="col-span-full px-4 py-6 text-[13px] leading-5 text-muted-foreground">
            No client matches “{menu.query}”. Press Enter to use the server URL. It works with any client that supports
            remote MCP servers.
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2.5 border-t border-menu-border bg-primary-wash py-2.5 pr-2.5 pl-4 text-[13px] text-muted-foreground">
        <span>
          <span className="font-semibold text-foreground">Not in the list?</span> Any client that supports remote MCP
          servers can connect.
        </span>
        <Button type="button" variant="outline" size="sm" onClick={() => onPick(ANY_CLIENT)}>
          Use the server URL
        </Button>
      </div>
    </div>
  )
}
