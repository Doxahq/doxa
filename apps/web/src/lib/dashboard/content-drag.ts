import type {
  DocsContentEdit,
  DocsContentNavigationSectionDto,
  DocsContentOverviewDto,
} from "@doxahq/contracts"

import type { ContentTreeSection } from "~/lib/dashboard/content-navigation"

export type ContentMoveEdit = Extract<DocsContentEdit, { type: `move_${string}` }>

/** The synthetic section that collects pages the published navigation omits. */
const ORPHAN_SECTION_SLUG = "__other"

interface ContentDragRowBase {
  id: string
  sectionSlug: string
  /** The rendered parent that owns this row. */
  containerId: string
  /** Indent level used by the live row and its drag preview. */
  depth: 0 | 1 | 2
  /** What the drag overlay and the drop preview call this row. */
  label: string
  /** False for a row the published navigation does not own. */
  canDrag: boolean
  /** False for a row that cannot receive a drop. */
  canDrop: boolean
}

/**
 * A row of the tree. A section or group row also carries `expandId`, the key
 * that opens and closes its branch.
 */
export type ContentDragRow =
  | (ContentDragRowBase & { kind: "section"; expandId: string })
  | (ContentDragRowBase & { kind: "group"; groupIndex: number; expandId: string })
  | (ContentDragRowBase & { kind: "page"; groupIndex: number | null; href: string })

/** Which half of the target row the pointer is over. */
export type ContentDropPlacement = "before" | "after"

/**
 * The line that marks where the dragged row lands.
 *
 * It is drawn on the edge of one visible row, so showing it moves no other
 * row. A preview that opens a gap pushes the rows under the pointer away, the
 * target changes, and the gap jumps: the line never does.
 */
export interface ContentDropIndicator {
  /** The row the line is drawn on. */
  rowId: string
  edge: "top" | "bottom"
  /**
   * Indent level of the line.
   *
   * A line at the wrong depth names the wrong parent. The three levels match
   * the row scale: a section, then a group or an ungrouped page, then a page
   * inside a group.
   */
  depth: 0 | 1 | 2
}

export interface ContentDropPlan {
  /** Null when the drop leaves the row where it is. */
  edit: ContentMoveEdit | null
  /** Null when there is nothing to show: the row would not move. */
  indicator: ContentDropIndicator | null
}

export function rootContainerId(): string {
  return "root"
}

export function sectionContainerId(slug: string): string {
  return `section:${slug}`
}

export function groupContainerId(groupId: string): string {
  return `group:${groupId}`
}

export function sectionRowId(slug: string): string {
  return `section:${slug}`
}

export function groupRowId(groupId: string): string {
  return `group:${groupId}`
}

export function pageRowId(href: string): string {
  return `page:${href}`
}

/**
 * The visible rows of the tree, in display order.
 *
 * A collapsed branch contributes no rows. A hidden element has no layout box,
 * so a collision test measures it at the origin and picks it as the target of
 * a drop the user cannot see.
 */
export function flattenContentTree(
  tree: readonly ContentTreeSection[],
  expandedIds: ReadonlySet<string>,
): ContentDragRow[] {
  const rows: ContentDragRow[] = []

  for (const section of tree) {
    // An unplaced page can move into a real section. Nothing can move into the
    // synthetic section that holds it, because no artifact describes it.
    const isOrphan = section.slug === ORPHAN_SECTION_SLUG
    rows.push({
      id: sectionRowId(section.slug),
      kind: "section",
      expandId: section.slug,
      sectionSlug: section.slug,
      containerId: rootContainerId(),
      depth: 0,
      label: section.label,
      canDrag: !isOrphan,
      canDrop: !isOrphan,
    })
    if (!expandedIds.has(section.slug)) continue

    for (const group of section.groups) {
      const groupIndex = group.groupIndex
      if (group.heading !== null && groupIndex !== null) {
        rows.push({
          id: groupRowId(group.id),
          kind: "group",
          expandId: group.id,
          sectionSlug: section.slug,
          containerId: sectionContainerId(section.slug),
          depth: 1,
          label: group.heading,
          groupIndex,
          canDrag: !isOrphan,
          canDrop: !isOrphan,
        })
        if (!expandedIds.has(group.id)) continue
      }

      for (const page of group.pages) {
        rows.push({
          id: pageRowId(page.href),
          kind: "page",
          sectionSlug: section.slug,
          containerId:
            group.heading === null
              ? sectionContainerId(section.slug)
              : groupContainerId(group.id),
          depth: group.heading === null ? 1 : 2,
          label: page.title,
          groupIndex,
          href: page.href,
          canDrag: true,
          canDrop: !isOrphan,
        })
      }
    }
  }

  return rows
}

/** The move a drop describes, or null when it is not allowed or moves nothing. */
export function resolveContentDrop(
  rows: readonly ContentDragRow[],
  activeId: string,
  overId: string,
  placement: ContentDropPlacement,
): ContentMoveEdit | null {
  return planContentDrop(rows, activeId, overId, placement)?.edit ?? null
}

/** The line that shows where the dragged row lands, or null for no line. */
export function resolveDropIndicator(
  rows: readonly ContentDragRow[],
  activeId: string,
  overId: string,
  placement: ContentDropPlacement,
): ContentDropIndicator | null {
  return planContentDrop(rows, activeId, overId, placement)?.indicator ?? null
}

/** A row's vertical span, measured once when a drag starts. */
export interface ContentRowBox {
  id: string
  top: number
  bottom: number
}

/**
 * The row under the pointer, and which half of it, read from the rows as they
 * were when the drag started. The drop line has no height, so the rows never
 * move during a drag and the measured positions stay true. Above the first row
 * or below the last, the nearest row answers.
 */
export function pointerTarget(
  boxes: readonly ContentRowBox[],
  pointerY: number,
): { overId: string; placement: ContentDropPlacement } | null {
  if (boxes.length === 0) return null
  const first = boxes[0]
  const last = boxes[boxes.length - 1]
  if (pointerY < first.top) return { overId: first.id, placement: "before" }
  if (pointerY >= last.bottom) return { overId: last.id, placement: "after" }
  const box = boxes.find((candidate) => pointerY < candidate.bottom)
  if (!box) return null
  return { overId: box.id, placement: pointerY < (box.top + box.bottom) / 2 ? "before" : "after" }
}

/** How long a dragged row rests on a closed branch before the branch opens. */
export const SPRING_OPEN_DELAY_MS = 350

/**
 * The closed branch a dragged row opens by resting on its header, or null.
 *
 * A branch opens only when it holds places the dragged row can land in. A
 * page lands inside a section or a group, so it opens both. A group lands
 * among the groups of a section, so it opens a section, never a group. A
 * section lands only between sections, so it opens nothing. A branch that
 * takes no drop stays closed.
 */
export function springOpenTarget(
  rows: readonly ContentDragRow[],
  activeId: string,
  overId: string,
  expandedIds: ReadonlySet<string>,
): string | null {
  const active = rows.find((row) => row.id === activeId)
  const over = rows.find((row) => row.id === overId)
  if (!active || !over || over.kind === "page" || !over.canDrop) return null
  const opens = active.kind === "page" || (active.kind === "group" && over.kind === "section")
  if (!opens) return null
  return expandedIds.has(over.expandId) ? null : over.expandId
}

/**
 * The branches that hold the place a move lands in: its section, and its
 * group when it has one. They are open after the drop, so the moved row
 * stays in view.
 */
export function destinationExpandIds(
  rows: readonly ContentDragRow[],
  edit: ContentMoveEdit,
): string[] {
  if (edit.type === "move_section") return []
  if (edit.type === "move_group") return [edit.toSectionSlug]
  const group = rows.find(
    (row) =>
      row.kind === "group" &&
      row.sectionSlug === edit.toSectionSlug &&
      row.groupIndex === edit.toGroupIndex,
  )
  return group?.kind === "group" ? [edit.toSectionSlug, group.expandId] : [edit.toSectionSlug]
}

/**
 * The drop that moves a row one place up or down, for Alt+Arrow on a focused
 * row. Nearby rows are tried in order, and the first drop that really moves
 * the row wins: the first page of a group moves up out of it, and a group
 * moves down past the whole next group.
 */
export function keyboardMoveTarget(
  rows: readonly ContentDragRow[],
  activeId: string,
  direction: "up" | "down",
): { overId: string; placement: ContentDropPlacement } | null {
  const index = rows.findIndex((row) => row.id === activeId)
  if (index < 0) return null
  const candidates: { overId: string; placement: ContentDropPlacement }[] = []
  if (direction === "up") {
    // The row just above: before it. Past it (a header of the row's own
    // group), the nearest slot is after the next row up.
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const id = rows[cursor].id
      if (cursor === index - 1) candidates.push({ overId: id, placement: "before" }, { overId: id, placement: "after" })
      else candidates.push({ overId: id, placement: "after" }, { overId: id, placement: "before" })
    }
  } else {
    for (let cursor = branchEndIndex(rows, index) + 1; cursor < rows.length; cursor += 1) {
      candidates.push({ overId: rows[cursor].id, placement: "after" }, { overId: rows[cursor].id, placement: "before" })
    }
  }
  return candidates.find((candidate) => planContentDrop(rows, activeId, candidate.overId, candidate.placement)?.edit) ?? null
}

/** A drop that leaves the row where it is: no request, no line. */
const STAY: ContentDropPlan = { edit: null, indicator: null }

/**
 * Resolves one drop to a move and to the line that previews it.
 *
 * The pointer decides the side: over the upper half of a row the dragged row
 * lands before it, over the lower half after it. The line is built from the
 * same result as the move, so it always marks the place the row lands.
 */
export function planContentDrop(
  rows: readonly ContentDragRow[],
  activeId: string,
  overId: string,
  placement: ContentDropPlacement,
): ContentDropPlan | null {
  const activeIndex = rows.findIndex((row) => row.id === activeId)
  const overIndex = rows.findIndex((row) => row.id === overId)
  if (activeIndex < 0 || overIndex < 0) return null

  const active = rows[activeIndex]
  const over = rows[overIndex]
  if (!active.canDrag) return null
  if (activeId === overId) return STAY
  if (!over.canDrop) return null
  if (isInsideBranch(rows, activeIndex, overIndex)) return null

  if (active.kind === "section") return planSectionDrop(rows, active, over, placement)
  if (active.kind === "group") return planGroupDrop(rows, active, over, placement)
  return planPageDrop(rows, active, over, placement)
}

function planSectionDrop(
  rows: readonly ContentDragRow[],
  active: ContentDragRow,
  over: ContentDragRow,
  placement: ContentDropPlacement,
): ContentDropPlan | null {
  const sections = rows.filter((row) => row.kind === "section" && row.canDrag)
  const others = sections.filter((row) => row.id !== active.id)
  const position = others.findIndex((row) => row.sectionSlug === over.sectionSlug)
  if (position < 0) return null
  const target = others[position]

  // Over a row inside another section's branch, the section lands after it.
  const after = over.kind !== "section" || placement === "after"
  const beforeSlug = after ? (others[position + 1]?.sectionSlug ?? null) : target.sectionSlug

  const currentNext = sections[sections.findIndex((row) => row.id === active.id) + 1]?.sectionSlug ?? null
  if (beforeSlug === currentNext) return STAY

  return {
    edit: { type: "move_section", slug: active.sectionSlug, beforeSlug },
    indicator: after
      ? { rowId: rows[branchEndIndex(rows, rows.indexOf(target))].id, edge: "bottom", depth: 0 }
      : { rowId: target.id, edge: "top", depth: 0 },
  }
}

function planGroupDrop(
  rows: readonly ContentDragRow[],
  active: Extract<ContentDragRow, { kind: "group" }>,
  over: ContentDragRow,
  placement: ContentDropPlacement,
): ContentDropPlan | null {
  const base = {
    type: "move_group",
    sectionSlug: active.sectionSlug,
    groupIndex: active.groupIndex,
    toSectionSlug: over.sectionSlug,
  } as const
  const groupsOf = (sectionSlug: string) =>
    rows.filter(
      (row): row is Extract<ContentDragRow, { kind: "group" }> =>
        row.kind === "group" && row.sectionSlug === sectionSlug,
    )
  const currentGroups = groupsOf(active.sectionSlug)
  const currentNext = currentGroups[currentGroups.findIndex((row) => row.id === active.id) + 1]?.groupIndex ?? null
  const stays = (beforeGroupIndex: number | null) =>
    over.sectionSlug === active.sectionSlug && beforeGroupIndex === currentNext

  const target = over.kind === "group" ? over : enclosingGroupRow(rows, over)
  if (!target) {
    // A section header, or an ungrouped page: the group goes last in that section.
    if (stays(null)) return STAY
    const sectionIndex = rows.findIndex((row) => row.kind === "section" && row.sectionSlug === over.sectionSlug)
    return {
      edit: { ...base, beforeGroupIndex: null },
      indicator: { rowId: rows[branchEndIndex(rows, sectionIndex)].id, edge: "bottom", depth: 1 },
    }
  }

  const groups = groupsOf(target.sectionSlug).filter((row) => row.id !== active.id)
  const position = groups.findIndex((row) => row.id === target.id)
  if (position < 0) return null

  // Over one of the target group's pages, the group lands after that group.
  const after = over.kind !== "group" || placement === "after"
  const beforeGroupIndex = after ? (groups[position + 1]?.groupIndex ?? null) : target.groupIndex
  if (stays(beforeGroupIndex)) return STAY

  return {
    edit: { ...base, beforeGroupIndex },
    indicator: after
      ? { rowId: rows[branchEndIndex(rows, rows.indexOf(target))].id, edge: "bottom", depth: 1 }
      : { rowId: target.id, edge: "top", depth: 1 },
  }
}

function planPageDrop(
  rows: readonly ContentDragRow[],
  active: Extract<ContentDragRow, { kind: "page" }>,
  over: ContentDragRow,
  placement: ContentDropPlacement,
): ContentDropPlan | null {
  const siblings = pagesOfContainer(rows, active.sectionSlug, active.groupIndex, "")
  const currentNext = siblings[siblings.findIndex((row) => row.id === active.id) + 1]?.href ?? null
  const stays = (sectionSlug: string, groupIndex: number | null, beforeHref: string | null) =>
    sectionSlug === active.sectionSlug && groupIndex === active.groupIndex && beforeHref === currentNext
  const move = (toSectionSlug: string, toGroupIndex: number | null, beforeHref: string | null) =>
    ({ type: "move_page", href: active.href, toSectionSlug, toGroupIndex, beforeHref }) as const

  if (over.kind === "section") {
    // Dropped on a section header, a page joins the section's pages that have
    // no group, after the last of them.
    if (stays(over.sectionSlug, null, null)) return STAY
    const lastUngrouped = pagesOfContainer(rows, over.sectionSlug, null, active.id).at(-1)
    return {
      edit: move(over.sectionSlug, null, null),
      indicator: { rowId: (lastUngrouped ?? over).id, edge: "bottom", depth: 1 },
    }
  }

  if (over.kind === "group") {
    // Dropped on a group header, a page lands at the top of that group.
    const first = pagesOfContainer(rows, over.sectionSlug, over.groupIndex, active.id).at(0)
    const beforeHref = first?.href ?? null
    if (stays(over.sectionSlug, over.groupIndex, beforeHref)) return STAY
    return {
      edit: move(over.sectionSlug, over.groupIndex, beforeHref),
      indicator: { rowId: over.id, edge: "bottom", depth: 2 },
    }
  }

  const container = pagesOfContainer(rows, over.sectionSlug, over.groupIndex, active.id)
  const position = container.findIndex((row) => row.id === over.id)
  if (position < 0) return null

  // The server removes the page before it inserts it, so the page that follows
  // the target is the anchor of an "after" drop.
  const after = placement === "after"
  const beforeHref = after ? (container[position + 1]?.href ?? null) : over.href
  if (stays(over.sectionSlug, over.groupIndex, beforeHref)) return STAY

  return {
    edit: move(over.sectionSlug, over.groupIndex, beforeHref),
    indicator: { rowId: over.id, edge: after ? "bottom" : "top", depth: over.depth },
  }
}



/** True when the target row sits inside the branch the dragged row owns. */
function isInsideBranch(
  rows: readonly ContentDragRow[],
  activeIndex: number,
  overIndex: number,
): boolean {
  if (rows[activeIndex].kind === "page") return false
  return overIndex > activeIndex && overIndex <= branchEndIndex(rows, activeIndex)
}

/** The last row that belongs to the branch this row owns. */
function branchEndIndex(rows: readonly ContentDragRow[], index: number): number {
  const row = rows[index]
  if (row.kind === "page") return index

  let end = index
  for (let cursor = index + 1; cursor < rows.length; cursor += 1) {
    const candidate = rows[cursor]
    if (candidate.kind === "section") break
    if (row.kind === "group" && candidate.kind === "group") break
    end = cursor
  }
  return end
}

function enclosingGroupRow(
  rows: readonly ContentDragRow[],
  row: ContentDragRow,
): Extract<ContentDragRow, { kind: "group" }> | undefined {
  if (row.kind !== "page" || row.groupIndex === null) return undefined
  return rows.find(
    (candidate): candidate is Extract<ContentDragRow, { kind: "group" }> =>
      candidate.kind === "group" &&
      candidate.sectionSlug === row.sectionSlug &&
      candidate.groupIndex === row.groupIndex,
  )
}

function pagesOfContainer(
  rows: readonly ContentDragRow[],
  sectionSlug: string,
  groupIndex: number | null,
  excludeId: string,
): Extract<ContentDragRow, { kind: "page" }>[] {
  return rows.filter(
    (row): row is Extract<ContentDragRow, { kind: "page" }> =>
      row.kind === "page" &&
      row.sectionSlug === sectionSlug &&
      row.groupIndex === groupIndex &&
      row.id !== excludeId,
  )
}

/**
 * Predicts the navigation one move produces.
 *
 * The prediction stops a dropped row from jumping back to its old place while
 * the request runs. Every move is deterministic from the overview returned by
 * the content API, including group renumbering and section URL prefixes.
 */
export function applyOptimisticMove(
  overview: DocsContentOverviewDto,
  edit: ContentMoveEdit,
): DocsContentOverviewDto | null {
  if (edit.type === "move_section") {
    const moved = overview.navigation.find((section) => section.slug === edit.slug)
    if (!moved) return null

    const rest = overview.navigation.filter((section) => section.slug !== edit.slug)
    const at =
      edit.beforeSlug === null
        ? rest.length
        : rest.findIndex((section) => section.slug === edit.beforeSlug)
    if (at < 0) return null

    return { ...overview, navigation: [...rest.slice(0, at), moved, ...rest.slice(at)] }
  }

  if (edit.type === "move_group") return applyOptimisticGroupMove(overview, edit)
  return applyOptimisticPageMove(overview, edit)
}

function applyOptimisticGroupMove(
  overview: DocsContentOverviewDto,
  edit: Extract<ContentMoveEdit, { type: "move_group" }>,
): DocsContentOverviewDto | null {
  const navigation = cloneNavigation(overview.navigation)
  const sourceSection = navigation.find((section) => section.slug === edit.sectionSlug)
  const targetSection = navigation.find((section) => section.slug === edit.toSectionSlug)
  const originalSource = overview.navigation.find((section) => section.slug === edit.sectionSlug)
  const originalTarget = overview.navigation.find((section) => section.slug === edit.toSectionSlug)
  if (!sourceSection || !targetSection || !originalSource || !originalTarget) return null

  const sourceIndex = sourceSection.groups.findIndex(
    (group) => group.groupIndex === edit.groupIndex,
  )
  if (sourceIndex < 0) return null

  const [movedGroup] = sourceSection.groups.splice(sourceIndex, 1)
  if (!movedGroup) return null

  const hrefChanges = new Map<string, string>()
  if (edit.sectionSlug !== edit.toSectionSlug) {
    movedGroup.hrefs = movedGroup.hrefs.map((href) => {
      const nextHref = moveHref(href, originalSource, originalTarget)
      hrefChanges.set(href, nextHref)
      return nextHref
    })
  }

  const targetIndex =
    edit.beforeGroupIndex === null
      ? targetSection.groups.length
      : targetSection.groups.findIndex((group) => group.groupIndex === edit.beforeGroupIndex)
  if (targetIndex < 0) return null
  targetSection.groups.splice(targetIndex, 0, movedGroup)

  renumberGroups(sourceSection)
  if (targetSection !== sourceSection) renumberGroups(targetSection)

  return {
    ...overview,
    navigation,
    pages: rewriteMovedPages(overview.pages, hrefChanges),
  }
}

function applyOptimisticPageMove(
  overview: DocsContentOverviewDto,
  edit: Extract<ContentMoveEdit, { type: "move_page" }>,
): DocsContentOverviewDto | null {
  const sourceLocation = findPageLocation(overview.navigation, edit.href)
  const originalTarget = overview.navigation.find(
    (section) => section.slug === edit.toSectionSlug,
  )
  if (!sourceLocation || !originalTarget) return null

  const nextHref =
    sourceLocation.section.slug === edit.toSectionSlug
      ? edit.href
      : moveHref(edit.href, sourceLocation.section, originalTarget)
  const navigation = cloneNavigation(overview.navigation)
  const sourceSection = navigation.find(
    (section) => section.slug === sourceLocation.section.slug,
  )
  const targetSection = navigation.find((section) => section.slug === edit.toSectionSlug)
  if (!sourceSection || !targetSection) return null

  const sourceGroup = sourceSection.groups.find(
    (group) => group.groupIndex === sourceLocation.groupIndex,
  )
  if (!sourceGroup) return null
  sourceGroup.hrefs = sourceGroup.hrefs.filter((href) => href !== edit.href)

  let targetGroup = targetSection.groups.find(
    (group) => group.groupIndex === edit.toGroupIndex,
  )
  if (!targetGroup && edit.toGroupIndex === null) {
    targetGroup = { heading: null, groupIndex: null, hrefs: [] }
    targetSection.groups.unshift(targetGroup)
  }
  if (!targetGroup) return null

  targetGroup.hrefs = insertHref(targetGroup.hrefs, nextHref, edit.beforeHref)
  const hrefChanges = nextHref === edit.href ? new Map<string, string>() : new Map([[edit.href, nextHref]])

  return {
    ...overview,
    navigation,
    pages: rewriteMovedPages(overview.pages, hrefChanges),
  }
}

function cloneNavigation(
  navigation: readonly DocsContentNavigationSectionDto[],
): DocsContentNavigationSectionDto[] {
  return navigation.map((section) => ({
    ...section,
    groups: section.groups.map((group) => ({ ...group, hrefs: [...group.hrefs] })),
  }))
}

function renumberGroups(section: DocsContentNavigationSectionDto): void {
  let groupIndex = 0
  for (const group of section.groups) {
    if (group.heading === null) {
      group.groupIndex = null
      continue
    }
    group.groupIndex = groupIndex
    groupIndex += 1
  }
}

function findPageLocation(
  navigation: readonly DocsContentNavigationSectionDto[],
  href: string,
): { section: DocsContentNavigationSectionDto; groupIndex: number | null } | null {
  for (const section of navigation) {
    const group = section.groups.find((candidate) => candidate.hrefs.includes(href))
    if (group) return { section, groupIndex: group.groupIndex }
  }
  return null
}

function rewriteMovedPages(
  pages: DocsContentOverviewDto["pages"],
  hrefChanges: ReadonlyMap<string, string>,
): DocsContentOverviewDto["pages"] {
  if (hrefChanges.size === 0) return pages
  return pages.map((page) => {
    const href = hrefChanges.get(page.href)
    return href ? { ...page, href, sourcePath: sourcePathForHref(href) } : page
  })
}

/** The source path the server stores a page under. Mirrors the docs engine rule. */
export function sourcePathForHref(href: string): string {
  const normalized = href.replace(/^\/+/, "").replace(/\/+$/, "")
  return normalized ? `source/${normalized}/index.mdx` : "source/index.mdx"
}

function insertHref(
  hrefs: readonly string[],
  href: string,
  beforeHref: string | null,
): string[] {
  const withoutMoved = hrefs.filter((candidate) => candidate !== href)
  const index = beforeHref === null ? withoutMoved.length : withoutMoved.indexOf(beforeHref)
  if (index < 0) return [...hrefs]
  return [...withoutMoved.slice(0, index), href, ...withoutMoved.slice(index)]
}

type ContentHrefSection =
  | ContentTreeSection
  | DocsContentNavigationSectionDto

/** Rewrites one href with the destination section prefix. */
export function moveHref(
  href: string,
  source: ContentHrefSection,
  target: ContentHrefSection,
): string {
  const sourcePrefix = sectionHrefPrefix(source)
  const slug = sourcePrefix
    ? href.replace(new RegExp(`^/${escapeRegExp(sourcePrefix)}/?`), "")
    : href.replace(/^\//, "")
  const targetPrefix = sectionHrefPrefix(target)
  return `/${[targetPrefix, slug].filter(Boolean).join("/")}`
}

/**
 * The path segment before every page slug of a section. The default section
 * owns the site root, so its prefix is empty.
 */
export function sectionHrefPrefix(section: ContentHrefSection): string {
  const hrefs = section.groups.flatMap((group) =>
    "hrefs" in group ? group.hrefs : group.pages.map((page) => page.href),
  )
  const isDefault = hrefs.some(
    (href) => !href.startsWith(`/${section.slug}/`) && href !== `/${section.slug}`,
  )
  return isDefault ? "" : section.slug
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** True when a move changes the href of the selected editor buffer. */
export function movesAcrossSections(
  edit: ContentMoveEdit,
  selectedHref: string | null,
  navigation: readonly DocsContentNavigationSectionDto[],
): boolean {
  if (!selectedHref || edit.type === "move_section") return false

  if (edit.type === "move_page") {
    if (edit.href !== selectedHref) return false
    const source = findPageLocation(navigation, edit.href)
    return source !== null && source.section.slug !== edit.toSectionSlug
  }

  if (edit.sectionSlug === edit.toSectionSlug) return false
  const source = navigation.find((section) => section.slug === edit.sectionSlug)
  const group = source?.groups.find((candidate) => candidate.groupIndex === edit.groupIndex)
  return group?.hrefs.includes(selectedHref) ?? false
}
