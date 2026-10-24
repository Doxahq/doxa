import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react"
import { createPortal } from "react-dom"
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  MouseSensor,
  pointerWithin,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import {
  SortableContext,
  useSortable,
  type SortingStrategy,
} from "@dnd-kit/sortable"
import { ChevronRight } from "lucide-react"
import type { DocsContentPageDto } from "@doxahq/contracts"

import { ContentPageRow } from "~/components/dashboard/content/content-page-row"
import type { PageSettingsTarget } from "~/components/dashboard/content/page-settings-dialog"
import { ContentRowActions } from "~/components/dashboard/content/content-row-actions"
import { ReviewChangeCountDots } from "~/components/dashboard/content/review/review-marks"
import type { ContentStructureDialogRequest } from "~/components/dashboard/content/content-structure-dialog"
import {
  ContentMoveConfirmation,
  type ContentMoveConfirmationValue,
} from "~/components/dashboard/content/content-move-confirmation"
import type { ContentDeleteConfirmationValue } from "~/components/dashboard/content/content-delete-confirmation"
import {
  createGroupRequest,
  createPageRequest,
  deleteGroupRequest,
  deletePageRequest,
  deleteSectionRequest,
  renameGroupRequest,
  renamePageRequest,
  renameSectionRequest,
  sectionHrefPrefix,
} from "~/components/dashboard/content/content-structure-dialog-requests"
import {
  CONTENT_ROW_CHILD_DEPTH,
  contentRowIndent,
  contentRowIndentRem,
  type ContentRowDepth,
} from "~/components/dashboard/content/content-row-indent"
import {
  findPagePath,
  type ContentTreeGroup,
  type ContentTreeSection,
  type ContentHomePage,
} from "~/lib/dashboard/content-navigation"
import {
  ContentRowGuide,
  GROUP_LABEL_CLASS,
  SECTION_LABEL_CLASS,
} from "~/components/dashboard/content/content-row-classes"
import { DocsPageIcon } from "~/components/dashboard/content/docs-icon"
import { resolveDocsSectionIcon } from "~/lib/dashboard/docs-icons"
import { cn } from "~/lib/utils"
import {
  readExpandedContentRows,
  writeExpandedContentRows,
} from "~/lib/dashboard/content-tree-expansion"
import { useReviewChangeCounts } from "~/lib/dashboard/review-page-marks-context"
import type { ContentStructureActions } from "~/lib/dashboard/use-content-structure"
import {
  flattenContentTree,
  groupRowId,
  destinationExpandIds,
  keyboardMoveTarget,
  moveHref,
  pageRowId,
  planContentDrop,
  SPRING_OPEN_DELAY_MS,
  springOpenTarget,
  pointerTarget,
  sectionRowId,
  type ContentRowBox,
  type ContentDragRow,
  type ContentDropIndicator,
  type ContentDropPlacement,
  type ContentMoveEdit,
} from "~/lib/dashboard/content-drag"

interface ContentPageTreeProps {
  /** Keys the open sections and groups saved in this browser. */
  projectId: string
  tree: readonly ContentTreeSection[]
  selectedHref: string | null
  /** The page that the site root shows. Its row carries a "Default" label. */
  home: ContentHomePage
  onSelect: (href: string) => void
  disabled: boolean
  /** Hides the row actions and turns off reordering, for a role without `docs.write`. */
  readOnly?: boolean
  structure?: ContentStructureActions
  openDialog: (request: ContentStructureDialogRequest) => void
  onDelete: (request: ContentDeleteConfirmationValue) => void
  /** Which pages are locked, and the settings of a page. */
  pageAgents: PageAgentControls
}

/** What a page row shows and opens about the agents that may change the page. */
export interface PageAgentControls {
  isLocked: (href: string) => boolean
  /** Absent for a role that cannot change page settings. */
  openSettings?: (page: PageSettingsTarget) => void
}

/**
 * The actions of the page rows. The object never changes, and each action
 * reads the tree's latest props when it runs. So a page row re-renders only
 * when its own page, place or selection changes, not on every page switch.
 */
interface PageRowActions {
  rename: (section: ContentTreeSection, page: DocsContentPageDto) => void
  delete: (page: DocsContentPageDto) => void
  setHome: (href: string) => void
  openSettings: (page: DocsContentPageDto) => void
  moveKey: (rowId: string, event: ReactKeyboardEvent) => void
}

interface PageRowActionSources {
  structure?: ContentStructureActions
  onSelect: (href: string) => void
  openDialog: (request: ContentStructureDialogRequest) => void
  onDelete: (request: ContentDeleteConfirmationValue) => void
  pageAgents: PageAgentControls
  moveKey: (rowId: string, event: ReactKeyboardEvent) => void
}

/** Builds the stable page row actions over the latest props in `sources`. */
function usePageRowActions(sources: PageRowActionSources): PageRowActions {
  const sourcesRef = useRef(sources)
  // The ref follows committed renders only, so an action never runs with the
  // props of a render that React threw away.
  useLayoutEffect(() => {
    sourcesRef.current = sources
  })
  return useMemo<PageRowActions>(
    () => ({
      rename: (section, page) => {
        const { openDialog, structure, onSelect } = sourcesRef.current
        openDialog(renamePageRequest(section, page, structure, onSelect))
      },
      delete: (page) => {
        const { onDelete, structure } = sourcesRef.current
        onDelete(deletePageRequest(page, structure))
      },
      setHome: (href) => {
        const { structure, onSelect } = sourcesRef.current
        setHomePage(structure, href, onSelect)
      },
      openSettings: (page) => sourcesRef.current.pageAgents.openSettings?.({ href: page.href, title: page.title }),
      moveKey: (rowId, event) => sourcesRef.current.moveKey(rowId, event),
    }),
    [],
  )
}

/**
 * Rows keep their place while a drag runs.
 *
 * The tree nests a section around its groups, and a group around its pages. A
 * shifting strategy translates a whole branch to open a gap for one row, and
 * that preview describes a result the drop never produces. A line on the edge
 * of the target row shows the landing place instead, and it moves no row.
 */
const noShift: SortingStrategy = () => null

/**
 * Row geometry shared by the live rows and the drop preview.
 *
 * The preview must occupy the same box as the row it becomes. A preview built
 * from its own classes drifts from the row, and the list then jumps when the
 * drop lands.
 */
const ROW_CLASS = "flex"

const DEFAULT_SECTION_DELETE_DISABLED_REASON =
  "The default section cannot be deleted."

/**
 * The node a drag carries.
 *
 * The preview renders this node with the components the list already uses, so
 * the preview and the dropped result are the same markup.
 */
type ContentDragSubject =
  | { kind: "section"; section: ContentTreeSection }
  | { kind: "group"; group: ContentTreeGroup }
  | { kind: "page"; page: DocsContentPageDto }

function findDragSubject(
  tree: readonly ContentTreeSection[],
  activeId: string | null,
): ContentDragSubject | null {
  if (!activeId) return null

  for (const section of tree) {
    if (sectionRowId(section.slug) === activeId) return { kind: "section", section }
    for (const group of section.groups) {
      if (group.heading !== null && groupRowId(group.id) === activeId) {
        return { kind: "group", group }
      }
      for (const page of group.pages) {
        if (pageRowId(page.href) === activeId) return { kind: "page", page }
      }
    }
  }
  return null
}

/** The expandable section and group tree for the content sidebar. */
export function ContentPageTree({
  projectId,
  tree,
  selectedHref,
  home,
  onSelect,
  disabled,
  readOnly = false,
  structure,
  openDialog,
  onDelete,
  pageAgents,
}: ContentPageTreeProps) {
  const selectedPath = useMemo(
    () => findPagePath(tree, selectedHref),
    [selectedHref, tree],
  )
  // The first render already uses the saved rows, so a reload shows the tree
  // as it was, with no closed frame first. The tree only renders in the
  // browser, once the content loads, so storage is there to read.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(
    () =>
      new Set([
        ...(readExpandedContentRows(projectId) ?? []),
        ...(selectedPath ? [selectedPath.sectionSlug, selectedPath.groupId] : []),
      ]),
  )
  const [activeId, setActiveId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const [placement, setPlacement] = useState<ContentDropPlacement>("after")
  // The drop reads the latest target, which the last move event may have set
  // after the last render.
  const targetRef = useRef<{ overId: string | null; placement: ContentDropPlacement }>({ overId: null, placement: "after" })
  const treeRef = useRef<HTMLDivElement | null>(null)
  /**
   * The rows as they stood when the drag started, in the scroll content's
   * coordinates, with the list that scrolls them. Targets are read from these,
   * never from the live list, which the drop preview changes.
   */
  const layoutRef = useRef<{ boxes: ContentRowBox[]; scroller: Element } | null>(null)
  /**
   * The real pointer position, from the browser. The drag's own delta
   * includes the offset that carries the row beside the pointer, so it does
   * not say where the pointer is.
   */
  const pointerRef = useRef<{ x: number; y: number } | null>(null)
  /** The closed branch a resting row is about to open, with its timer. */
  const springRef = useRef<{ expandId: string; timer: number } | null>(null)
  /** The branches this drag opened. They close again when it ends. */
  const springOpenedRef = useRef<Set<string>>(new Set())
  /** Set when the drag opened a branch: the rows are measured again after it renders. */
  const remeasureRef = useRef(false)

  useEffect(
    () => () => {
      if (springRef.current) window.clearTimeout(springRef.current.timer)
    },
    [],
  )

  useEffect(() => {
    const onMove = (event: PointerEvent | MouseEvent | TouchEvent) => {
      pointerRef.current = pointerPoint(event) ?? pointerRef.current
    }
    // Mouse and touch events are read as well as pointer events, so the
    // position stays current even if a pointer event is held back.
    const types = ["pointermove", "mousemove", "touchmove"] as const
    for (const type of types) window.addEventListener(type, onMove, { capture: true, passive: true })
    return () => {
      for (const type of types) window.removeEventListener(type, onMove, { capture: true })
    }
  }, [])
  const [moveConfirmation, setMoveConfirmation] =
    useState<ContentMoveConfirmationValue | null>(null)

  const rows = useMemo(() => flattenContentTree(tree, expandedIds), [expandedIds, tree])
  // A new id list would update every sortable row, so it changes only with the rows.
  const rowIds = useMemo(() => rows.map((row) => row.id), [rows])
  // A row resting on a closed branch is waiting for it to open: it shows no
  // line, and a drop there moves nothing. The line comes once the branch is
  // open and the row can reach a place inside it.
  const isWaitingToOpen = (activeRowId: string, overRowId: string) =>
    springOpenTarget(rows, activeRowId, overRowId, expandedIds) !== null
  const indicator = useMemo(
    () =>
      activeId && overId && springOpenTarget(rows, activeId, overId, expandedIds) === null
        ? (planContentDrop(rows, activeId, overId, placement)?.indicator ?? null)
        : null,
    [activeId, expandedIds, overId, placement, rows],
  )
  const subject = useMemo(() => findDragSubject(tree, activeId), [activeId, tree])
  const [lineBox, setLineBox] = useState<DropLineBox | null>(null)

  // The line is placed from the live box of the row it names, and follows
  // the list when it scrolls. It is drawn on the page, so nothing in the
  // sidebar can clip it or cover it. Only the carried row goes over it.
  useLayoutEffect(() => {
    const root = treeRef.current
    const scroller = layoutRef.current?.scroller
    if (!indicator || !root || !scroller) {
      setLineBox(null)
      return
    }
    const place = () => setLineBox(dropLineBox(root, scroller, indicator))
    place()
    const scrollTarget = isPageScroller(scroller) ? window : scroller
    scrollTarget.addEventListener("scroll", place, { passive: true })
    return () => scrollTarget.removeEventListener("scroll", place)
  }, [indicator])
  const activeRow = useMemo(
    () => rows.find((row) => row.id === activeId) ?? null,
    [activeId, rows],
  )
  const dragDisabled = disabled || readOnly || (structure?.isPending ?? false)
  // A press anywhere on a row starts a drag once the pointer moves a few
  // pixels, so a plain click still opens the row. On touch, a short hold
  // starts it, so a swipe still scrolls the list.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 6 } }),
  )

  useEffect(() => {
    if (!selectedPath) return
    setExpandedIds((current) => {
      if (
        current.has(selectedPath.sectionSlug) &&
        current.has(selectedPath.groupId)
      ) {
        return current
      }
      const next = new Set(current)
      next.add(selectedPath.sectionSlug)
      next.add(selectedPath.groupId)
      return next
    })
  }, [selectedPath])

  // Save the open rows. A drag opens branches for a moment and closes them
  // when it ends, so nothing is saved while a row is carried.
  useEffect(() => {
    if (activeId || tree.length === 0) return
    writeExpandedContentRows(projectId, tree, expandedIds)
  }, [activeId, expandedIds, projectId, tree])

  // The whole page shows the grabbing hand while a row is carried, even
  // outside the list.
  useEffect(() => {
    if (!activeId) return
    const previous = document.body.style.cursor
    document.body.style.cursor = "grabbing"
    return () => {
      document.body.style.cursor = previous
    }
  }, [activeId])

  const toggleExpanded = (id: string) => {
    setExpandedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const cancelSpring = () => {
    if (springRef.current) window.clearTimeout(springRef.current.timer)
    springRef.current = null
  }

  /**
   * Ends the drag. The branches it opened close again. The section and group
   * the row lands in, `landing`, open or stay open, so the moved row stays in
   * view.
   */
  const clearDrag = (landing: readonly string[] = []) => {
    cancelSpring()
    const close = [...springOpenedRef.current].filter((id) => !landing.includes(id))
    springOpenedRef.current = new Set()
    remeasureRef.current = false
    if (close.length > 0 || landing.length > 0) {
      setExpandedIds((current) => {
        const next = new Set(current)
        for (const id of close) next.delete(id)
        for (const id of landing) next.add(id)
        return next
      })
    }
    setActiveId(null)
    setOverId(null)
    targetRef.current = { overId: null, placement: "after" }
    layoutRef.current = null
  }

  /** Measures every visible row, at the start of a drag and after it opens a branch. */
  const measureLayout = () => {
    const root = treeRef.current
    if (!root) return
    const scroller = scrollParent(root)
    const toContent = contentOffset(scroller)
    const boxes: ContentRowBox[] = []
    for (const row of rows) {
      const element = root.querySelector(`[data-drag-row="${CSS.escape(row.id)}"]`)
      if (!element) continue
      const rect = element.getBoundingClientRect()
      boxes.push({ id: row.id, top: rect.top + toContent, bottom: rect.bottom + toContent })
    }
    layoutRef.current = { boxes, scroller }
  }

  /**
   * The row under the pointer, and which half of it: the upper half means
   * "before this row", the lower half "after it". The pointer is read against
   * the rows measured at drag start, corrected for scrolling. Outside the list
   * there is no target: no line shows, and a drop there moves nothing.
   */
  const trackTarget = (activeRowId: string) => {
    const layout = layoutRef.current
    const pointer = pointerRef.current
    if (!layout || !pointer) return
    const bounds = listBounds(layout.scroller)
    const target =
      pointer.x < bounds.left || pointer.x > bounds.right || pointer.y < bounds.top || pointer.y > bounds.bottom
        ? null
        : pointerTarget(layout.boxes, pointer.y + contentOffset(layout.scroller))
    targetRef.current = target ?? { overId: null, placement: "after" }
    setOverId(target?.overId ?? null)
    if (target) setPlacement(target.placement)
    armSpring(activeRowId, target?.overId ?? null)
  }

  /**
   * A page that rests on a closed group or section, or a group that rests on
   * a closed section, opens it, so the user can reach the exact place inside.
   * Moving to another row first cancels it.
   */
  const armSpring = (activeRowId: string, overRowId: string | null) => {
    const expandId = overRowId ? springOpenTarget(rows, activeRowId, overRowId, expandedIds) : null
    if (springRef.current?.expandId === expandId) return
    cancelSpring()
    if (!expandId) return
    const timer = window.setTimeout(() => {
      springRef.current = null
      springOpenedRef.current.add(expandId)
      remeasureRef.current = true
      setExpandedIds((current) => new Set(current).add(expandId))
    }, SPRING_OPEN_DELAY_MS)
    springRef.current = { expandId, timer }
  }

  // An opened branch moves the rows below it, so the rows are measured again
  // and the target is read afresh. The row under the pointer is the header of
  // the branch, which does not move, so nothing jumps.
  useLayoutEffect(() => {
    if (!remeasureRef.current || !activeId) return
    remeasureRef.current = false
    measureLayout()
    trackTarget(activeId)
    // Runs after the render that shows the opened branch.
  }, [expandedIds])

  /** Runs the move a drop, or an Alt+Arrow key, asks for. */
  const commitMove = async (activeRowId: string, targetRowId: string, targetPlacement: ContentDropPlacement) => {
    const plan = planContentDrop(rows, activeRowId, targetRowId, targetPlacement)
    if (!plan?.edit) return
    const edit = plan.edit

    const activeRow = rows.find((row) => row.id === activeRowId)
    const targetSectionSlug = targetSectionForEdit(edit)
    if (activeRow && targetSectionSlug && activeRow.sectionSlug !== targetSectionSlug) {
      const nextSelectedHref = selectedHrefAfterMove(
        tree,
        activeRow,
        targetSectionSlug,
        selectedHref,
      )
      setMoveConfirmation({
        description: describeCrossSectionMove(tree, activeRow, targetSectionSlug),
        onConfirm: async () => {
          await structure?.moveNode(edit)
          setMoveConfirmation(null)
          if (nextSelectedHref) onSelect(nextSelectedHref)
        },
      })
      return
    }

    // The hook keeps the failure message, and the editor shows it.
    await structure?.moveNode(edit).catch(() => undefined)
  }

  /** Alt+Up and Alt+Down move the focused row one place, for keyboard users. */
  const moveWithKeys = (rowId: string, event: ReactKeyboardEvent) => {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown") || dragDisabled) return
    event.preventDefault()
    const target = keyboardMoveTarget(rows, rowId, event.key === "ArrowUp" ? "up" : "down")
    if (target) void commitMove(rowId, target.overId, target.placement)
  }

  const handleDragEnd = async ({ active }: DragEndEvent) => {
    const { overId: targetRowId, placement: targetPlacement } = targetRef.current
    const activeRowId = String(active.id)
    const dropsHere = targetRowId !== null && !isWaitingToOpen(activeRowId, targetRowId)
    const edit = dropsHere ? (planContentDrop(rows, activeRowId, targetRowId, targetPlacement)?.edit ?? null) : null
    clearDrag(edit ? destinationExpandIds(rows, edit) : [])
    if (dropsHere) await commitMove(activeRowId, targetRowId, targetPlacement)
  }

  const rowActions = usePageRowActions({
    structure,
    onSelect,
    openDialog,
    onDelete,
    pageAgents,
    moveKey: moveWithKeys,
  })

  const orphanSection = tree.length === 1 && tree[0]?.slug === "__other" ? tree[0] : null
  if (orphanSection) {
    return orphanSection.groups.flatMap((group) => group.pages).map((page) => (
      <ContentPageRow
        key={page.href}
        page={page}
        isSelected={page.href === selectedHref}
        home={home}
        onSelect={onSelect}
        disabled={disabled}
        isLocked={pageAgents.isLocked(page.href)}
      />
    ))
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      // Rows are measured once, when the drag starts. Nothing moves them
      // during a drag, and the target is read from those measurements.
      measuring={{ droppable: { strategy: MeasuringStrategy.BeforeDragging } }}
      onDragStart={({ active, activatorEvent }) => {
        pointerRef.current = pointerPoint(activatorEvent) ?? pointerRef.current
        measureLayout()
        setActiveId(String(active.id))
      }}
      onDragMove={({ active }) => trackTarget(String(active.id))}
      onDragOver={({ active }) => trackTarget(String(active.id))}
      onDragCancel={() => clearDrag()}
      onDragEnd={(event) => void handleDragEnd(event)}
    >
      <SortableContext items={rowIds} strategy={noShift}>
        <div ref={treeRef}>
        {tree.map((section) => (
            <SectionBranch
              key={section.slug}
              section={section}
              expandedIds={expandedIds}
              onToggle={toggleExpanded}
              selectedHref={selectedHref}
              home={home}
              onSelect={onSelect}
              disabled={disabled}
              readOnly={readOnly}
              dragDisabled={dragDisabled}
              structure={structure}
              openDialog={openDialog}
              onDelete={onDelete}
              onMoveKey={moveWithKeys}
              pageAgents={pageAgents}
              rowActions={rowActions}
            />
          ))}
        </div>
      </SortableContext>
      {/* The carried row is drawn over the whole page, so it can leave the
          list and the sidebar. It keeps the spot where it was grabbed, under
          the pointer. It is the top layer: the drop line runs under it. */}
      {typeof document === "undefined"
        ? null
        : createPortal(
            <>
              <DragOverlay dropAnimation={null} zIndex={60}>
                {subject && activeRow ? <ContentRowPreview subject={subject} depth={activeRow.depth} /> : null}
              </DragOverlay>
              {lineBox ? <DropLine box={lineBox} /> : null}
            </>,
            document.body,
          )}
      <ContentMoveConfirmation
        value={moveConfirmation}
        pending={structure?.isPending ?? false}
        onOpenChange={(open) => {
          if (!open) setMoveConfirmation(null)
        }}
      />
    </DndContext>
  )
}

interface BranchProps {
  section: ContentTreeSection
  expandedIds: ReadonlySet<string>
  onToggle: (id: string) => void
  selectedHref: string | null
  home: ContentHomePage
  onSelect: (href: string) => void
  disabled: boolean
  readOnly: boolean
  dragDisabled: boolean
  structure?: ContentStructureActions
  openDialog: (request: ContentStructureDialogRequest) => void
  onDelete: (request: ContentDeleteConfirmationValue) => void
  /** Where the dragged row lands: the row the line sits against. */
  /** Alt+Arrow on a row: move it one place. */
  onMoveKey: (rowId: string, event: ReactKeyboardEvent) => void
  pageAgents: PageAgentControls
  rowActions: PageRowActions
}

function SectionBranch({
  section,
  expandedIds,
  onToggle,
  selectedHref,
  home,
  onSelect,
  disabled,
  readOnly,
  dragDisabled,
  structure,
  openDialog,
  onDelete,
  onMoveKey,
  pageAgents,
  rowActions,
}: BranchProps) {
  const rowId = sectionRowId(section.slug)
  const sortable = useSortable({ id: rowId, disabled: dragDisabled })
  const isExpanded = expandedIds.has(section.slug)
  const regionId = regionIdFor("section", section.slug)
  const SectionIcon = resolveDocsSectionIcon(isExpanded)

  return (
    <div>
      <div
        ref={sortable.setNodeRef}
        data-drag-row={rowId}
        {...dragSource(sortable, rowId, onMoveKey)}
        style={contentRowIndent(0)}
        className={cn(
          "group/row relative hover:bg-overlay",
          ROW_CLASS,
          sortable.isDragging && "opacity-40",
        )}
      >
        <button
          type="button"
          onClick={() => onToggle(section.slug)}
          aria-expanded={isExpanded}
          aria-controls={regionId}
          className={cn(SECTION_LABEL_CLASS, "text-label hover:text-foreground")}
        >
          <SectionIcon aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-left">{section.label}</span>
          {isExpanded ? null : (
            <CollapsedChangeMark
              pages={section.groups.flatMap((group) => group.pages)}
              editedCount={section.editedCount}
              hideOnRowHover={!readOnly}
            />
          )}
        </button>
        {readOnly ? null : (
          <ContentRowActions
            disabled={disabled}
            target={`the section ${section.label}`}
            onRename={() => openDialog(renameSectionRequest(section, structure))}
            onDelete={() => onDelete(deleteSectionRequest(section, structure))}
            deleteDisabledReason={
              section.isDefault ? DEFAULT_SECTION_DELETE_DISABLED_REASON : null
            }
            createAction={{
              label: `New group in ${section.label}`,
              onClick: () => openDialog(createGroupRequest(section, structure, onSelect)),
            }}
          />
        )}
      </div>
      <div id={regionId} hidden={!isExpanded} className="relative">
        {isExpanded ? (
          <>
            <ContentRowGuide depth={CONTENT_ROW_CHILD_DEPTH[0]} />
            <SectionContents
              section={section}
              childDepth={CONTENT_ROW_CHILD_DEPTH[0]}
              expandedIds={expandedIds}
              onToggle={onToggle}
              selectedHref={selectedHref}
              home={home}
              onSelect={onSelect}
              disabled={disabled}
              readOnly={readOnly}
              dragDisabled={dragDisabled}
              structure={structure}
              openDialog={openDialog}
              onDelete={onDelete}
              onMoveKey={onMoveKey}
              pageAgents={pageAgents}
              rowActions={rowActions}
            />
          </>
        ) : null}
      </div>
    </div>
  )
}

/**
 * The groups of one section.
 *
 * A group with no heading has no row of its own. Its pages sit at the depth
 * the group row would have taken, so the list never shows an unlabelled row.
 */
function SectionContents({
  section,
  childDepth,
  expandedIds,
  onToggle,
  selectedHref,
  home,
  onSelect,
  disabled,
  readOnly,
  dragDisabled,
  structure,
  openDialog,
  onDelete,
  onMoveKey,
  pageAgents,
  rowActions,
}: BranchProps & { childDepth: ContentRowDepth }) {
  const children: ReactNode[] = []

  for (const group of section.groups) {
    if (group.heading === null) {
      children.push(
        ...group.pages.map((page) => (
          <SortablePageRow
            key={page.href}
            page={page}
            section={section}
            isSelected={page.href === selectedHref}
            home={home}
            onSelect={onSelect}
            disabled={disabled}
            readOnly={readOnly}
            dragDisabled={dragDisabled}
            depth={childDepth}
            isLocked={pageAgents.isLocked(page.href)}
            canOpenSettings={!readOnly && pageAgents.openSettings !== undefined}
            actions={rowActions}
          />
        )),
      )
      continue
    }

    children.push(
      <GroupBranch
        key={group.id}
        group={group}
        depth={childDepth}
        expandedIds={expandedIds}
        onToggle={onToggle}
        selectedHref={selectedHref}
        home={home}
        onSelect={onSelect}
        disabled={disabled}
        readOnly={readOnly}
        dragDisabled={dragDisabled}
        section={section}
        structure={structure}
        openDialog={openDialog}
        onDelete={onDelete}
        onMoveKey={onMoveKey}
        pageAgents={pageAgents}
        rowActions={rowActions}
      />
    )
  }

  return children
}

interface GroupBranchProps extends BranchProps {
  group: ContentTreeGroup
  depth: ContentRowDepth
}

function GroupBranch({
  group,
  section,
  depth,
  expandedIds,
  onToggle,
  selectedHref,
  home,
  onSelect,
  disabled,
  readOnly,
  dragDisabled,
  structure,
  openDialog,
  onDelete,
  onMoveKey,
  pageAgents,
  rowActions,
}: GroupBranchProps) {
  const rowId = groupRowId(group.id)
  const sortable = useSortable({ id: rowId, disabled: dragDisabled })
  const isExpanded = expandedIds.has(group.id)
  const regionId = regionIdFor("group", group.id)

  return (
    <div>
      <div
        ref={sortable.setNodeRef}
        data-drag-row={rowId}
        {...dragSource(sortable, rowId, onMoveKey)}
        style={contentRowIndent(depth)}
        className={cn(
          "group/row relative hover:bg-overlay",
          ROW_CLASS,
          sortable.isDragging && "opacity-40",
        )}
      >
        <button
          type="button"
          onClick={() => onToggle(group.id)}
          aria-expanded={isExpanded}
          aria-controls={regionId}
          className={cn(GROUP_LABEL_CLASS, "text-body hover:text-foreground")}
        >
          {/* A group marks its open state with a chevron. A section swaps its
              folder glyph instead, so the two levels stay apart at a glance. */}
          <ChevronRight
            aria-hidden="true"
            className={cn("size-3 shrink-0 transition-transform", isExpanded && "rotate-90")}
          />
          <span className="min-w-0 flex-1 truncate text-left">{group.heading}</span>
          {isExpanded ? null : (
            <CollapsedChangeMark pages={group.pages} editedCount={group.editedCount} hideOnRowHover={!readOnly} />
          )}
          <span className={cn("flex shrink-0 items-center gap-1.5 pr-1", !readOnly && "group-hover/row:invisible")}>
            <span
              aria-label={`${group.pages.length} ${group.pages.length === 1 ? "page" : "pages"}`}
              className="font-mono text-[10.5px] font-normal text-label"
            >
              {group.pages.length}
            </span>
          </span>
        </button>
        {readOnly ? null : (
          <ContentRowActions
            disabled={disabled}
            target={`the group ${group.heading}`}
            onRename={() => openDialog(renameGroupRequest(section, group, structure))}
            onDelete={() => onDelete(deleteGroupRequest(section, group, structure))}
            deleteDisabledReason={null}
            createAction={{
              label: `New page in ${group.heading}`,
              onClick: () => openDialog(createPageRequest(section, group, structure, onSelect)),
            }}
          />
        )}
      </div>
      <div id={regionId} hidden={!isExpanded} className="relative">
        {isExpanded ? <ContentRowGuide depth={CONTENT_ROW_CHILD_DEPTH[depth]} /> : null}
        {isExpanded
          ? group.pages.map((page) => (
              <SortablePageRow
                key={page.href}
                page={page}
                section={section}
                isSelected={page.href === selectedHref}
                home={home}
                onSelect={onSelect}
                disabled={disabled}
                readOnly={readOnly}
                dragDisabled={dragDisabled}
                depth={CONTENT_ROW_CHILD_DEPTH[depth]}
                isLocked={pageAgents.isLocked(page.href)}
                canOpenSettings={!readOnly && pageAgents.openSettings !== undefined}
                actions={rowActions}
              />
            ))
          : null}
      </div>
    </div>
  )
}

interface SortablePageRowProps {
  page: DocsContentPageDto
  section: ContentTreeSection
  isSelected: boolean
  home: ContentHomePage
  onSelect: (href: string) => void
  disabled: boolean
  readOnly: boolean
  dragDisabled: boolean
  depth: ContentRowDepth
  isLocked: boolean
  /** True when the row offers "Page settings". */
  canOpenSettings: boolean
  actions: PageRowActions
}

/**
 * A page row in the tree. Every prop stays the same across a page switch,
 * except `isSelected` on the two rows that change, so only those re-render.
 */
const SortablePageRow = memo(function SortablePageRow({
  page,
  section,
  readOnly,
  dragDisabled,
  canOpenSettings,
  actions,
  ...rowProps
}: SortablePageRowProps) {
  const rowId = pageRowId(page.href)
  const sortable = useSortable({ id: rowId, disabled: dragDisabled })
  // The drag context re-renders this wrapper during drags and tree changes.
  // Stable callbacks keep the memoized row below from re-rendering with it.
  const rowActions = useMemo(
    () => ({
      onRename: readOnly ? undefined : () => actions.rename(section, page),
      onDelete: readOnly ? undefined : () => actions.delete(page),
      onSetHome: readOnly ? undefined : () => actions.setHome(page.href),
      onOpenPageSettings: canOpenSettings ? () => actions.openSettings(page) : undefined,
    }),
    [actions, canOpenSettings, page, readOnly, section],
  )

  return (
    // The row stays in the list and dims. Removing it collapses the source box,
    // and the drag overlay then jumps to the top of the page.
    <>
      <div
        ref={sortable.setNodeRef}
        data-drag-row={rowId}
        {...dragSource(sortable, rowId, actions.moveKey)}
        className={cn(sortable.isDragging && "opacity-40")}
      >
        <ContentPageRow {...rowProps} page={page} {...rowActions} />
      </div>
    </>
  )
})

/**
 * The drop line between two rows, in page coordinates. It is drawn over the
 * whole page, under the carried row, and moves no row, so nothing under the
 * pointer shifts. It starts
 * at the indent of the place the dragged row takes, with a small ring at its
 * start, so it names both the position and the new parent.
 */
function DropLine({ box }: { box: DropLineBox }) {
  return (
    <div
      aria-hidden="true"
      style={{ top: box.top, left: box.left, width: box.width }}
      className="pointer-events-none fixed z-50 h-0.5 -translate-y-1/2 rounded-full bg-foreground/90 before:absolute before:-top-[3px] before:-left-2 before:size-2 before:rounded-full before:border-2 before:border-foreground/90 before:bg-sidebar"
    />
  )
}

/**
 * The dragged node: its icon and title on a solid dark gray chip, with a gray
 * edge. The chip keeps the spot where the row was grabbed, so nothing jumps
 * when the drag starts.
 *
 * The chip is only as wide as its content. The row under the pointer is
 * where the line is drawn, so a chip as wide as the row would cover that row
 * and the line would read as the chip's own border. A short chip leaves the
 * line in plain view past its end.
 */
function ContentRowPreview({ subject, depth }: { subject: ContentDragSubject; depth: ContentRowDepth }) {
  const content =
    subject.kind === "page" ? (
      <PagePreviewLabel page={subject.page} />
    ) : subject.kind === "section" ? (
      <span className={cn(SECTION_LABEL_CLASS, "flex-none")}>
        <SectionFolderIcon aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">{subject.section.label}</span>
      </span>
    ) : (
      <span className={cn(GROUP_LABEL_CLASS, "flex-none")}>
        <ChevronRight aria-hidden="true" className="size-3 shrink-0" />
        <span className="min-w-0 truncate">{subject.group.heading}</span>
      </span>
    )

  return (
    // The overlay box is the row's box. The chip starts half a rem before the
    // row's content, so its icon stays where the row's icon was. It sits under
    // the pointer, so it lets the pointer through.
    <div
      aria-hidden="true"
      style={{ paddingLeft: `${contentRowIndentRem(depth) - 0.5}rem` }}
      className="pointer-events-none flex h-full items-stretch"
    >
      {/* It is drawn on the page, outside the dashboard frame, so it sets
          the dashboard font itself. */}
      <div className="flex max-w-full min-w-0 items-center bg-muted px-2 font-sans text-foreground shadow-xl outline outline-border-strong">
        {content}
      </div>
    </div>
  )
}

function PagePreviewLabel({ page }: { page: DocsContentPageDto }) {
  return (
    <span className="flex min-w-0 items-center gap-2 py-[5px]">
      <DocsPageIcon name={page.icon} className="size-4 shrink-0 opacity-70" />
      <span className="min-w-0 truncate text-[13.5px]">{page.title}</span>
    </span>
  )
}

/** A closed section keeps the folder glyph the collapsed row uses. */
const SectionFolderIcon = resolveDocsSectionIcon(false)

/**
 * Makes a whole row the drag source. The row keeps its own buttons: a click
 * still opens a page or a section, and a drag starts only once the pointer
 * moves. The row is not a button itself, because it holds buttons. Keyboard
 * users move it with Alt+Up and Alt+Down from any of its buttons.
 */
function dragSource(
  sortable: ReturnType<typeof useSortable>,
  rowId: string,
  onMoveKey: (rowId: string, event: ReactKeyboardEvent) => void,
) {
  return {
    ...sortable.listeners,
    "aria-keyshortcuts": "Alt+ArrowUp Alt+ArrowDown",
    onKeyDown: (event: ReactKeyboardEvent) => onMoveKey(rowId, event),
  }
}

interface DropLineBox {
  top: number
  left: number
  width: number
}

/** The line's place on the page: the named edge of the row, inside the list. */
function dropLineBox(root: Element, scroller: Element, indicator: ContentDropIndicator): DropLineBox | null {
  const row = root.querySelector(`[data-drag-row="${CSS.escape(indicator.rowId)}"]`)
  if (!row) return null
  const rect = row.getBoundingClientRect()
  const top = indicator.edge === "top" ? rect.top : rect.bottom
  const bounds = listBounds(scroller)
  if (top < bounds.top - 1 || top > bounds.bottom + 1) return null
  const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
  const left = rect.left + contentRowIndentRem(indicator.depth) * rem
  return { top, left, width: Math.max(0, rect.right - left) }
}

/** The viewport position of a pointer, mouse or touch event. */
function pointerPoint(event: Event | null): { x: number; y: number } | null {
  if (!event) return null
  if ("touches" in event) {
    const touch = (event as TouchEvent).touches[0] ?? (event as TouchEvent).changedTouches[0]
    return touch ? { x: touch.clientX, y: touch.clientY } : null
  }
  if ("clientX" in event) {
    const { clientX, clientY } = event as MouseEvent
    return { x: clientX, y: clientY }
  }
  return null
}

function isPageScroller(scroller: Element): boolean {
  return scroller === document.scrollingElement || scroller === document.documentElement
}

/** The visible box of the list, where a drop can land. */
function listBounds(scroller: Element): { left: number; right: number; top: number; bottom: number } {
  if (isPageScroller(scroller)) {
    return { left: 0, right: window.innerWidth, top: 0, bottom: window.innerHeight }
  }
  return scroller.getBoundingClientRect()
}

/** The element that scrolls the tree: the nearest scrolling ancestor, or the page. */
function scrollParent(element: Element): Element {
  for (let current = element.parentElement; current; current = current.parentElement) {
    const { overflowY } = getComputedStyle(current)
    if (overflowY === "auto" || overflowY === "scroll") return current
  }
  return document.scrollingElement ?? document.documentElement
}

/**
 * The amount that turns a viewport y into a y in the scroll content, so rows
 * measured at drag start still match after the list scrolls.
 */
function contentOffset(scroller: Element): number {
  return scroller.scrollTop - (isPageScroller(scroller) ? 0 : scroller.getBoundingClientRect().top)
}

function targetSectionForEdit(edit: ContentMoveEdit): string | null {
  if (edit.type === "move_page" || edit.type === "move_group") return edit.toSectionSlug
  return null
}

function describeCrossSectionMove(
  tree: readonly ContentTreeSection[],
  active: ContentDragRow,
  targetSectionSlug: string,
): string {
  const source = tree.find((section) => section.slug === active.sectionSlug)
  const target = tree.find((section) => section.slug === targetSectionSlug)
  if (!source || !target) return "The moved pages will receive new URLs."

  if (active.kind === "page") {
    return `${active.href} will become ${moveHref(active.href, source, target)}.`
  }
  if (active.kind === "group") {
    const count = countGroupPages(source, active.groupIndex)
    const prefix = sectionHrefPrefix(target) || "default"
    return `${count} ${count === 1 ? "page" : "pages"} in this group will receive the ${prefix} section URL prefix.`
  }
  return "The moved pages will receive new URLs."
}

function countGroupPages(section: ContentTreeSection, groupIndex: number): number {
  return section.groups.find((group) => group.groupIndex === groupIndex)?.pages.length ?? 0
}

function selectedHrefAfterMove(
  tree: readonly ContentTreeSection[],
  active: ContentDragRow,
  targetSectionSlug: string,
  selectedHref: string | null,
): string | null {
  if (!selectedHref || active.kind === "section") return null

  const source = tree.find((section) => section.slug === active.sectionSlug)
  const target = tree.find((section) => section.slug === targetSectionSlug)
  if (!source || !target) return null

  const moved =
    active.kind === "page"
      ? active.href === selectedHref
      : (source.groups
          .find((group) => group.groupIndex === active.groupIndex)
          ?.pages.some((page) => page.href === selectedHref) ?? false)
  if (!moved) return null

  return moveHref(selectedHref, source, target)
}

/**
 * What a closed section or group holds. In a review, the dots of the
 * changes, which stay on hover so their tooltip can open. Elsewhere, the
 * dot of unpublished changes, which steps aside for the row actions.
 */
function CollapsedChangeMark(props: {
  pages: readonly DocsContentPageDto[]
  editedCount: number
  hideOnRowHover: boolean
}) {
  const reviewCounts = useReviewChangeCounts(props.pages.map((page) => page.href))
  if (reviewCounts) return <ReviewChangeCountDots counts={reviewCounts} />
  if (props.editedCount === 0) return null
  return (
    <span className={cn("flex shrink-0 items-center", props.hideOnRowHover && "group-hover/row:invisible")}>
      <EditedCount count={props.editedCount} />
    </span>
  )
}

function EditedCount({ count }: { count: number }) {
  return (
    <span
      role="img"
      aria-label={`${count} ${count === 1 ? "page" : "pages"} with unpublished changes`}
      title={`${count} ${count === 1 ? "page" : "pages"} with unpublished changes`}
      className="size-1.5 shrink-0 rounded-full bg-warning"
    />
  )
}

function regionIdFor(level: "section" | "group", id: string): string {
  return `content-${level}-${encodeURIComponent(id)}`
}

/**
 * Makes a page the default and opens it. The page list marks it at once, with
 * a spinner until the server answers. The hook keeps a failure message, and
 * the editor shows it.
 */
function setHomePage(
  structure: ContentStructureActions | undefined,
  href: string,
  onSelect: (href: string) => void,
) {
  onSelect(href)
  void structure?.setHomePage(href).catch(() => undefined)
}
