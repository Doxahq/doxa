import { useDeferredValue, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import {
  CORE_ICON_NODES,
  DocsIconSvg,
  docsIconLabel,
  LUCIDE_ICON_COUNT,
  SUGGESTED_ICON_NAMES,
  type DocsIconNode,
} from "@doxahq/docs-prose/icons"
import { Ban, Check, Search } from "lucide-react"

import { MenuSectionLabel } from "~/components/dashboard/shell/menu-parts"
import { Skeleton } from "~/components/ui/skeleton"
import {
  currentIconName,
  preloadDocsIcons,
  SUGGESTED_ICON_SEARCH_WORDS,
  useLucideIcons,
  useLucideTags,
} from "~/lib/dashboard/docs-icons"
import { buildIconSearchEntries, searchIcons } from "~/lib/dashboard/icon-search"
import { cn } from "~/lib/utils"

const COLUMNS = 8
const ROW_HEIGHT = 36
const HEADING_HEIGHT = 28
/** The height of the scrolling grid. Fixed, so the window of drawn rows needs no measuring. */
const VIEWPORT_HEIGHT = 288
const GRID_PADDING = 6
const OVERSCAN = ROW_HEIGHT * 3
const SKELETON_ROWS = 3

type Row =
  | { kind: "heading"; top: number; label: ReactNode }
  | { kind: "icons"; top: number; start: number; names: readonly string[] }
  | { kind: "skeleton"; top: number }

interface Section {
  key: string
  label: ReactNode
  names: readonly string[]
  /** The names are still loading: draw placeholder rows after them. */
  loading?: boolean
}

interface Layout {
  rows: Row[]
  /** Every icon in grid order. An icon can be in two sections. */
  items: string[]
  /** The row of each item. */
  itemRows: number[]
  height: number
}

/** Places the sections as rows: a heading, then the icons eight to a row. */
function layoutSections(sections: readonly Section[]): Layout {
  const rows: Row[] = []
  const items: string[] = []
  const itemRows: number[] = []
  let top = 0
  for (const section of sections) {
    if (section.names.length === 0 && !section.loading) continue
    rows.push({ kind: "heading", top, label: section.label })
    top += HEADING_HEIGHT
    for (let start = 0; start < section.names.length; start += COLUMNS) {
      const names = section.names.slice(start, start + COLUMNS)
      for (const name of names) {
        items.push(name)
        itemRows.push(rows.length)
      }
      rows.push({ kind: "icons", top, start: items.length - names.length, names })
      top += ROW_HEIGHT
    }
    if (section.loading) {
      for (let index = 0; index < SKELETON_ROWS; index++) {
        rows.push({ kind: "skeleton", top })
        top += ROW_HEIGHT
      }
    }
  }
  return { rows, items, itemRows, height: top }
}

/** A scroll position inside the grid, which has padding around its rows. */
function clampScroll(top: number, contentHeight: number): number {
  return Math.max(0, Math.min(top, contentHeight + GRID_PADDING * 2 - VIEWPORT_HEIGHT))
}

function rowHeight(row: Row): number {
  return row.kind === "heading" ? HEADING_HEIGHT : ROW_HEIGHT
}

/**
 * Every Lucide icon in a searchable grid, for the page icon and the card
 * icon pickers.
 *
 * The suggested icons draw at once from the main bundle. The full set and its
 * search words load when the picker opens, and placeholder rows hold their
 * place until then. Only the rows in view are drawn, so the grid stays fast
 * with nearly two thousand icons.
 *
 * Focus stays in the search field. The arrow keys move through the grid,
 * Enter chooses the highlighted icon, and the pointer highlights too.
 */
export function IconPickerPanel({
  value,
  onSelect,
  onRemove,
}: {
  /** The stored icon name, or null for none. */
  value: string | null
  onSelect: (name: string) => void
  /** Shows a "Remove" button when set. */
  onRemove?: () => void
}) {
  const id = useId()
  const icons = useLucideIcons()
  const tags = useLucideTags()
  const [query, setQuery] = useState("")
  const search = useDeferredValue(query)
  const current = currentIconName(value, icons)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)

  useEffect(() => preloadDocsIcons({ tags: true }), [])

  const allNames = useMemo(() => (icons ? Object.keys(icons.icons) : null), [icons])
  const entries = useMemo(
    () => buildIconSearchEntries(allNames ?? SUGGESTED_ICON_NAMES, tags, SUGGESTED_ICON_SEARCH_WORDS),
    [allNames, tags],
  )

  const layout = useMemo(() => {
    if (search.trim()) {
      return layoutSections([
        { key: "results", label: "Results", names: searchIcons(entries, search), loading: !allNames },
      ])
    }
    return layoutSections([
      { key: "suggested", label: "Suggested", names: SUGGESTED_ICON_NAMES },
      {
        key: "all",
        label: (
          <>
            All icons <span className="tracking-normal">· {LUCIDE_ICON_COUNT.toLocaleString("en-US")}</span>
          </>
        ),
        names: allNames ?? [],
        loading: !allNames,
      },
    ])
  }, [allNames, entries, search])

  function scrollTo(top: number) {
    const next = clampScroll(top, layout.height)
    if (scrollerRef.current) scrollerRef.current.scrollTop = next
    setScrollTop(next)
  }

  // The highlight starts on the current icon, and on the best match of a search.
  const [active, setActive] = useState(() => layout.items.indexOf(current ?? ""))
  const searched = useRef(search)
  useEffect(() => {
    if (searched.current === search) return
    searched.current = search
    setActive(layout.items.length > 0 ? 0 : -1)
    if (scrollerRef.current) scrollerRef.current.scrollTop = 0
    setScrollTop(0)
  }, [layout, search])

  // Once the full set loads, bring a current icon from the long list into view.
  const revealedCurrent = useRef(false)
  useEffect(() => {
    if (revealedCurrent.current || !allNames || !current || search.trim()) return
    revealedCurrent.current = true
    if (SUGGESTED_ICON_NAMES.includes(current)) return
    const index = layout.items.lastIndexOf(current)
    if (index < 0) return
    setActive(index)
    const row = layout.rows[layout.itemRows[index]!]!
    const top = clampScroll(row.top - (VIEWPORT_HEIGHT - ROW_HEIGHT) / 2, layout.height)
    if (scrollerRef.current) scrollerRef.current.scrollTop = top
    setScrollTop(top)
  }, [allNames, current, layout, search])

  function highlight(index: number) {
    setActive(index)
    const rowIndex = layout.itemRows[index]
    if (rowIndex === undefined) return
    const row = layout.rows[rowIndex]!
    // Keep a section heading in view with its first row.
    const above = layout.rows[rowIndex - 1]
    const top = above?.kind === "heading" ? above.top : row.top
    if (top < scrollTop) scrollTo(top)
    else if (row.top + ROW_HEIGHT + GRID_PADDING * 2 > scrollTop + VIEWPORT_HEIGHT) {
      scrollTo(row.top + ROW_HEIGHT + GRID_PADDING * 2 - VIEWPORT_HEIGHT)
    }
  }

  /** The item in the next or previous row of icons, in the same column where it can. */
  function verticalNeighbor(index: number, direction: 1 | -1): number {
    const rowIndex = layout.itemRows[index]!
    const row = layout.rows[rowIndex] as Extract<Row, { kind: "icons" }>
    const column = index - row.start
    for (let next = rowIndex + direction; next >= 0 && next < layout.rows.length; next += direction) {
      const candidate = layout.rows[next]!
      if (candidate.kind === "icons") return candidate.start + Math.min(column, candidate.names.length - 1)
    }
    return index
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const count = layout.items.length
    if (count === 0) return
    const from = active < 0 ? -1 : active
    let next: number | null = null
    switch (event.key) {
      case "ArrowRight":
        next = Math.min(from + 1, count - 1)
        break
      case "ArrowLeft":
        next = Math.max(from - 1, 0)
        break
      case "ArrowDown":
        next = from < 0 ? 0 : verticalNeighbor(from, 1)
        break
      case "ArrowUp":
        next = from < 0 ? 0 : verticalNeighbor(from, -1)
        break
      case "Enter":
        event.preventDefault()
        if (from >= 0) onSelect(layout.items[from]!)
        return
      default:
        return
    }
    event.preventDefault()
    highlight(next)
  }

  function nodeFor(name: string): DocsIconNode | null {
    return CORE_ICON_NODES[name] ?? icons?.icons[name] ?? null
  }

  const listId = `${id}-icons`
  const optionId = (index: number) => `${id}-icon-${index}`
  const activeName = active >= 0 ? layout.items[active] : undefined
  const windowTop = scrollTop - OVERSCAN
  const windowBottom = scrollTop + VIEWPORT_HEIGHT + OVERSCAN

  return (
    <div className="flex flex-col">
      <div className="flex h-10 items-center gap-2 border-b border-divider px-3">
        <Search aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search icons…"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={activeName !== undefined ? optionId(active) : undefined}
          aria-autocomplete="list"
          spellCheck={false}
          className="h-full w-full bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
        />
      </div>
      <div
        ref={scrollerRef}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        className="scrollbar-subtle relative overflow-x-hidden overflow-y-auto"
        style={{ height: VIEWPORT_HEIGHT, padding: GRID_PADDING }}
      >
        {layout.items.length === 0 && !layout.rows.some((row) => row.kind === "skeleton") ? (
          <p className="py-6 text-center text-xs text-muted-foreground">No icon matches.</p>
        ) : null}
        <div id={listId} role="listbox" aria-label="Icons" className="relative" style={{ height: layout.height }}>
          {layout.rows.map((row, rowIndex) => {
            if (row.top + rowHeight(row) < windowTop || row.top > windowBottom) return null
            const style = { top: row.top, height: rowHeight(row) }
            if (row.kind === "heading") {
              return (
                <div key={rowIndex} role="presentation" className="absolute inset-x-0 flex items-end px-1 pb-1.5" style={style}>
                  <MenuSectionLabel>{row.label}</MenuSectionLabel>
                </div>
              )
            }
            if (row.kind === "skeleton") {
              return (
                <div key={rowIndex} aria-hidden="true" className="absolute inset-x-0 grid grid-cols-8 gap-0.5" style={style}>
                  {Array.from({ length: COLUMNS }, (_, cell) => (
                    <div key={cell} className="grid place-items-center">
                      <Skeleton className="size-[18px] rounded-[3px]" />
                    </div>
                  ))}
                </div>
              )
            }
            return (
              <div key={rowIndex} role="presentation" className="absolute inset-x-0 grid grid-cols-8 gap-0.5" style={style}>
                {row.names.map((name, cell) => {
                  const index = row.start + cell
                  const label = docsIconLabel(name)
                  const isCurrent = name === current
                  return (
                    <div
                      key={name}
                      id={optionId(index)}
                      role="option"
                      aria-selected={index === active}
                      aria-current={isCurrent || undefined}
                      aria-label={label}
                      title={label}
                      data-selected={index === active || undefined}
                      onPointerMove={() => {
                        if (index !== active) setActive(index)
                      }}
                      // Keeps focus in the search field.
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => onSelect(name)}
                      className={cn(
                        "grid cursor-default place-items-center text-muted-foreground transition-colors duration-75 data-selected:bg-overlay data-selected:text-foreground",
                        isCurrent && "bg-primary-wash text-primary-text data-selected:bg-primary-wash data-selected:text-primary-text",
                      )}
                    >
                      <DocsIconSvg node={nodeFor(name)} className="size-[18px]" />
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
      <div className="flex h-9 items-center justify-between gap-2 border-t border-divider pr-1 pl-3">
        <span data-slot="icon-picker-highlight" className="flex min-w-0 items-center gap-1.5 truncate text-xs text-muted-foreground">
          {activeName ? docsIconLabel(activeName) : "Choose an icon"}
          {activeName && activeName === current ? <Check aria-hidden="true" className="size-3.5 text-primary-text" /> : null}
        </span>
        {onRemove ? (
          <button
            type="button"
            onClick={onRemove}
            className="flex h-7 items-center gap-1.5 px-2 text-xs text-muted-foreground hover:bg-overlay hover:text-foreground [&_svg]:size-3.5"
          >
            <Ban aria-hidden="true" />
            Remove
          </button>
        ) : null}
      </div>
    </div>
  )
}
