import { useEffect, useId, useMemo, useState, type ReactElement, type ReactNode } from "react"
import { createFileTree, StepFrame, StepList, Tabs, TabsList, TabsTrigger, type FileTreeComponents } from "@doxahq/docs-prose"
import { TextSelection } from "@tiptap/pm/state"
import { NodeViewContent, NodeViewWrapper, useEditorState, type ReactNodeViewProps } from "@tiptap/react"

import { Mermaid, PREVIEW_FILE_TREE_ICONS } from "~/components/dashboard/content/preview-components"
import type { FileTreeItem, MdxAttribute } from "~/lib/editor/mdx-document"

/**
 * Views for the container components: steps, tabs, file trees and diagrams.
 * Each draws the shared docs component, so the block looks as it will on the
 * site. Their settings live in the component bar, outside the site canvas.
 */

/** Steps: the site's step column. Each item draws its own frame. */
export function StepsView() {
  return (
    <NodeViewWrapper>
      <StepList>
        <NodeViewContent />
      </StepList>
    </NodeViewWrapper>
  )
}

/**
 * One step: the numbered frame around its title and body. The number follows
 * the item's place, so it is read from the document on every change.
 */
export function StepItemView({ editor, getPos }: ReactNodeViewProps) {
  const place = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const pos = getPos()
      if (typeof pos !== "number") return { index: 0, count: 1 }
      const $pos = current.state.doc.resolve(pos)
      return { index: $pos.index(), count: $pos.parent.childCount }
    },
    equalityFn: (left, right) => left?.index === right?.index && left?.count === right?.count,
  })
  return (
    <NodeViewWrapper>
      <StepFrame number={(place?.index ?? 0) + 1} last={(place?.index ?? 0) === (place?.count ?? 1) - 1} markerProps={{ contentEditable: false }}>
        {/* The site's StepItem wrapper. The title and body nodes draw the rest. */}
        <NodeViewContent className="pt-0.5!" />
      </StepFrame>
    </NodeViewWrapper>
  )
}

/** The attribute value of a component, or undefined. */
function attributeValue(attributes: unknown, name: string): string | undefined {
  return ((attributes ?? []) as MdxAttribute[]).find((attribute) => attribute.name === name)?.value ?? undefined
}

/**
 * Tabs: the site's tab list over the panels. A trigger opens its tab and puts
 * the cursor in it, and the tab with the cursor is the one shown. Hidden
 * panels stay in the document, so their text is still saved and searchable.
 */
export function TabsView({ node, editor, getPos }: ReactNodeViewProps) {
  const scope = useId()
  const labels: string[] = []
  node.forEach((child) => labels.push(String(child.attrs.label ?? "")))

  // The tab that holds the cursor, while the cursor is in this block.
  const cursorTab = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const pos = getPos()
      if (typeof pos !== "number") return null
      const { from } = current.state.selection
      if (from <= pos || from >= pos + node.nodeSize) return null
      const $from = current.state.doc.resolve(from)
      for (let depth = $from.depth; depth > 0; depth -= 1) {
        if ($from.before(depth) === pos) return $from.index(depth)
      }
      return null
    },
  })
  const [active, setActive] = useState(0)
  useEffect(() => {
    if (cursorTab !== null) setActive(cursorTab)
  }, [cursorTab])
  const shown = Math.min(active, labels.length - 1)

  function open(index: number) {
    setActive(index)
    const pos = getPos()
    if (typeof pos !== "number") return
    let start = pos + 1
    for (let child = 0; child < index; child += 1) start += node.child(child).nodeSize
    const { state, view } = editor
    view.dispatch(state.tr.setSelection(TextSelection.near(state.doc.resolve(start + 1))))
    view.focus()
  }

  return (
    <NodeViewWrapper data-tabs-view={scope}>
      {/* Only this block's own panels: a tab set inside a tab has its own scope. */}
      <style>
        {`[data-tabs-view="${scope}"] > [data-slot="tabs"] > .doxa-tab-panels > [data-node-view-content-react] > [data-tab-item]:not(:nth-child(${shown + 1})) { display: none; }`}
      </style>
      <Tabs value={String(shown)} onValueChange={(value) => open(Number(value))} className={attributeValue(node.attrs.attributes, "className")}>
        <div contentEditable={false}>
          <TabsList>
            {labels.map((label, index) => (
              <TabsTrigger key={index} value={String(index)}>
                {label || `Tab ${index + 1}`}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <NodeViewContent className="doxa-tab-panels" />
      </Tabs>
    </NodeViewWrapper>
  )
}

/** The site's file tree, drawn with the dashboard's copy of the same icons. */
const EDITOR_FILE_TREE: FileTreeComponents = createFileTree(PREVIEW_FILE_TREE_ICONS)

function renderTreeItems(items: readonly FileTreeItem[], prefix = ""): ReactNode {
  const { Folder, File } = EDITOR_FILE_TREE
  return items.map((item, index) => {
    const name = attributeValue(item.attributes, "name") ?? ""
    const label = attributeValue(item.attributes, "label")
    const key = `${prefix}${index}:${name}`
    // The renderer passes `label` through as MDX gives it: a string.
    const labelProp = label as unknown as ReactElement | undefined
    if (item.kind === "file") return <File key={key} name={name} label={labelProp} />
    const defaultOpen = item.attributes.some((attribute) => attribute.name === "defaultOpen" && attribute.value !== "false")
    return (
      <Folder key={key} name={name} label={labelProp} defaultOpen={defaultOpen}>
        {renderTreeItems(item.children ?? [], `${key}/`)}
      </Folder>
    )
  })
}

/** The value, once it has not changed for `delay` milliseconds. */
function useSettledValue<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay)
    return () => clearTimeout(timer)
  }, [delay, value])
  return settled
}

/** A file tree. Folders open and close as on the site; the bar edits the outline. */
export function FileTreeView({ node, selected }: ReactNodeViewProps) {
  const items = (node.attrs.items ?? []) as FileTreeItem[]
  const { FileTree } = EDITOR_FILE_TREE
  const tree = useMemo(() => renderTreeItems(items), [items])
  return (
    <NodeViewWrapper className="doxa-atom-block" data-selected={selected || undefined}>
      <div contentEditable={false}>
        <FileTree>{tree}</FileTree>
      </div>
    </NodeViewWrapper>
  )
}

/**
 * A diagram, drawn by the site's Mermaid component. The bar edits its chart.
 * While the chart is typed, the diagram waits for a short pause, so a
 * half-typed line does not replace the drawing with an error.
 */
export function MermaidView({ node, selected }: ReactNodeViewProps) {
  const chart = useSettledValue(String(node.attrs.chart ?? ""), 500)
  return (
    <NodeViewWrapper className="doxa-atom-block" data-selected={selected || undefined}>
      <div contentEditable={false}>
        <Mermaid chart={chart} />
      </div>
    </NodeViewWrapper>
  )
}
