import type { JSONContent } from "@tiptap/core"
import type {
  AlignType,
  BlockContent,
  DefinitionContent,
  List,
  ListItem,
  PhrasingContent,
  RootContent,
  Table,
  TableCell,
  TableRow,
} from "mdast"
import type { MdxJsxAttribute, MdxJsxFlowElement, MdxJsxTextElement } from "mdast-util-mdx-jsx"
import { readFrontmatter, readStringLiteral } from "@doxahq/mdx-runtime"
import { parseMdxTree, stringifyMdxTree } from "@doxahq/mdx-runtime/format"

/**
 * The bridge between a page's MDX source and the Write editor document.
 *
 * Loading keeps each top-level block's original text. Saving writes an
 * untouched block back byte for byte and writes only edited blocks in the
 * shared Doxa style (`@doxahq/mdx-runtime/format`). A block the editor cannot
 * model (API components, JavaScript) becomes a locked `mdxBlock` that holds
 * its source as it is.
 */

/**
 * An attribute of a JSX component: `name="value"`, a bare `name` (value null),
 * or `name={literal}` for a literal the renderer reads without running code
 * (`true`, `false`, a number), which sets `expression`.
 */
export interface MdxAttribute {
  name: string
  value: string | null
  expression?: true
}

/** One card of a card group: its attributes and its body text. */
export interface MdxCard {
  attributes: MdxAttribute[]
  body: string | null
  /**
   * The body is Markdown (inline code, emphasis, links), written back as
   * parsed Markdown. A plain-text body is written back as text.
   */
  markdown?: true
  /**
   * For a one-line card, `<Card>text</Card>`, which MDX reads as inline JSX:
   * the paragraph it shares with the one-line cards next to it.
   */
  line?: number
}

/** A folder or file of a `<FileTree>`, with its attributes (`name`, `label`, `defaultOpen`). */
export interface FileTreeItem {
  kind: "folder" | "file"
  attributes: MdxAttribute[]
  children?: FileTreeItem[]
}

interface SourceBlock {
  /** The block's original text. */
  text: string
  /** The text between the previous block and this one. */
  gapBefore: string
}

export interface MdxDocument {
  source: string
  /** The frontmatter text with its `---` lines, or "". */
  head: string
  title: string
  description: string
  blocks: SourceBlock[]
  /** The text after the last block. */
  tail: string
  /** The editor document. Top-level nodes carry `blockId`, their index in `blocks`. */
  content: JSONContent
}

export function parseMdxDocument(source: string): MdxDocument {
  const { content: body, frontmatter } = readFrontmatter(source)
  const head = source.slice(0, source.length - body.length)
  const base = {
    source,
    head,
    title: frontmatter.title ?? "",
    description: frontmatter.description ?? "",
  }

  let children: RootContent[]
  try {
    children = parseMdxTree(body).children
  } catch {
    // Invalid MDX stays editable as one locked source block.
    const text = body.trim()
    return {
      ...base,
      blocks: text ? [{ text, gapBefore: body.slice(0, body.indexOf(text)) }] : [],
      tail: text ? body.slice(body.indexOf(text) + text.length) : body,
      content: {
        type: "doc",
        content: text ? [withBlockId(rawBlock(text), 0)] : [{ type: "paragraph" }],
      },
    }
  }

  const blocks: SourceBlock[] = []
  const content: JSONContent[] = []
  let cursor = 0
  for (const node of children) {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (start === undefined || end === undefined) continue
    const text = body.slice(start, end)
    blocks.push({ text, gapBefore: body.slice(cursor, start) })
    content.push(withBlockId(toEditorBlock(node) ?? rawBlock(text), blocks.length - 1))
    cursor = end
  }

  return {
    ...base,
    blocks,
    tail: body.slice(cursor),
    content: { type: "doc", content: content.length > 0 ? content : [{ type: "paragraph" }] },
  }
}

/**
 * The editor's own JSON for each loaded block, keyed by `blockId`. Capture it
 * right after the editor loads the document, so schema defaults are included.
 */
export function captureOriginalBlocks(doc: JSONContent): Map<number, string> {
  const originals = new Map<number, string>()
  for (const node of doc.content ?? []) {
    const id = blockIdOf(node)
    if (id !== null && !originals.has(id)) originals.set(id, JSON.stringify(node))
  }
  return originals
}

/**
 * Writes the editor document back to MDX. A block whose JSON still equals its
 * loaded JSON keeps its original text and spacing. Any other block is written
 * in the shared style.
 */
export function serializeMdxDocument(
  document: MdxDocument,
  editorDoc: JSONContent,
  originals: ReadonlyMap<number, string>,
  meta: { title: string; description: string },
): string {
  let head = document.head
  if (meta.title !== document.title) head = setFrontmatterField(head, "title", meta.title)
  if (meta.description !== document.description) head = setFrontmatterField(head, "description", meta.description)

  let body = ""
  let previousOriginal: number | null = null
  let lastOriginal: number | null = null
  const used = new Set<number>()

  for (const node of editorDoc.content ?? []) {
    if (isEmptyParagraph(node)) continue
    const id = blockIdOf(node)
    const isOriginal = id !== null && !used.has(id) && originals.get(id) === JSON.stringify(node)
    if (id !== null) used.add(id)

    let gap: string
    let text: string
    if (isOriginal && id !== null) {
      const block = document.blocks[id]
      text = block.text
      gap = body === "" || previousOriginal === id - 1 ? block.gapBefore : "\n\n"
      if (body === "" && id !== 0) gap = document.blocks[0]?.gapBefore ?? ""
      previousOriginal = id
      lastOriginal = id
    } else {
      text = stringifyEditorBlock(node)
      if (!text) continue
      gap = body === "" ? (document.blocks[0]?.gapBefore ?? "") : "\n\n"
      previousOriginal = null
      lastOriginal = null
    }
    body += gap + text
  }

  const tail =
    lastOriginal !== null && lastOriginal === document.blocks.length - 1 ? document.tail : body ? "\n" : ""
  return head + body + tail
}

/** Writes one editor block in the shared style, without a trailing newline. */
export function stringifyEditorBlock(node: JSONContent): string {
  const block = fromEditorBlock(node)
  if (!block) return ""
  return stringifyMdxTree({ type: "root", children: [block] }).replace(/\n+$/, "")
}

// ─── MDX → editor ──────────────────────────────────────────────────────────

type Mark = NonNullable<JSONContent["marks"]>[number]

export function rawBlock(source: string): JSONContent {
  return { type: "mdxBlock", attrs: { source } }
}

function withBlockId(node: JSONContent, blockId: number): JSONContent {
  return { ...node, attrs: { ...node.attrs, blockId } }
}

function toEditorBlock(node: RootContent): JSONContent | null {
  // A diagram's chart is a template literal, which is data, not code.
  if (node.type === "mdxJsxFlowElement" && node.name === "Mermaid") return toEditorMermaid(node)
  if (containsJavaScript(node)) return null
  switch (node.type) {
    case "paragraph": {
      const image = toEditorImage(node.children)
      if (image) return image
      const content = toEditorInline(node.children, [])
      if (content) return { type: "paragraph", ...(content.length > 0 ? { content } : {}) }
      return toEditorLooseCards(node.children)
    }
    case "heading": {
      const content = toEditorInline(node.children, [])
      return content ? { type: "heading", attrs: { level: node.depth }, ...(content.length > 0 ? { content } : {}) } : null
    }
    case "thematicBreak":
      return { type: "horizontalRule" }
    case "code":
      return {
        type: "codeBlock",
        attrs: { language: node.lang ?? null, meta: node.meta ?? null },
        ...(node.value ? { content: [{ type: "text", text: node.value }] } : {}),
      }
    case "list":
      return toEditorList(node)
    case "blockquote": {
      const content = toEditorChildren(node.children)
      return content && content.length > 0 ? { type: "blockquote", content } : null
    }
    case "table":
      return toEditorTable(node)
    case "mdxJsxFlowElement":
      return toEditorComponent(node)
    default:
      return null
  }
}

/**
 * A GFM table. The first row is the header. Each cell holds one line of
 * inline text, and the column alignment rides on every cell of its column.
 */
function toEditorTable(table: Table): JSONContent | null {
  const rows: JSONContent[] = []
  for (const [rowIndex, row] of table.children.entries()) {
    const cells: JSONContent[] = []
    for (const [column, cell] of row.children.entries()) {
      const content = toEditorInline(cell.children, [])
      if (!content) return null
      cells.push({
        type: rowIndex === 0 ? "tableHeader" : "tableCell",
        attrs: { align: table.align?.[column] ?? null },
        content: [{ type: "paragraph", ...(content.length > 0 ? { content } : {}) }],
      })
    }
    rows.push({ type: "tableRow", content: cells })
  }
  return rows.length > 0 ? { type: "table", content: rows } : null
}

function toEditorList(list: List): JSONContent | null {
  const items: JSONContent[] = []
  for (const item of list.children) {
    const converted = toEditorListItem(item)
    if (!converted) return null
    items.push(converted)
  }
  return list.ordered
    ? { type: "orderedList", attrs: { start: list.start ?? 1, spread: list.spread ?? false }, content: items }
    : { type: "bulletList", attrs: { spread: list.spread ?? false }, content: items }
}

function toEditorListItem(item: ListItem): JSONContent | null {
  // Task lists have no editor equivalent.
  if (item.checked !== null && item.checked !== undefined) return null
  if (item.children[0]?.type !== "paragraph") return null
  const content = toEditorChildren(item.children)
  return content ? { type: "listItem", attrs: { spread: item.spread ?? false }, content } : null
}

function toEditorChildren(children: (BlockContent | DefinitionContent)[]): JSONContent[] | null {
  const content: JSONContent[] = []
  for (const child of children) {
    const converted = toEditorBlock(child as RootContent)
    if (!converted || converted.type === "mdxBlock") return null
    content.push(converted)
  }
  return content
}

function toEditorComponent(node: MdxJsxFlowElement): JSONContent | null {
  const attributes = plainAttributes(node)
  if (!attributes) return null

  if (node.name === "Note") {
    const content = toEditorChildren(node.children as BlockContent[])
    if (!content) return null
    return { type: "callout", attrs: { attributes }, content: content.length > 0 ? content : [{ type: "paragraph" }] }
  }

  if (node.name === "Step") return toEditorSteps(node, attributes)
  if (node.name === "Tabs") return toEditorTabs(node, attributes)
  if (node.name === "FileTree") {
    const items = toFileTreeItems(node.children)
    return items ? { type: "fileTree", attrs: { attributes, items } } : null
  }

  if (node.name === "CardGrid") {
    const cards: MdxCard[] = []
    for (const [index, child] of node.children.entries()) {
      // One-line cards on neighbouring lines share one paragraph of inline
      // `<Card>`s, with line breaks between them.
      const elements =
        child.type === "paragraph"
          ? child.children.filter((part) => !(part.type === "text" && part.value.trim() === ""))
          : [child]
      for (const element of elements) {
        if ((element.type !== "mdxJsxFlowElement" && element.type !== "mdxJsxTextElement") || element.name !== "Card") {
          return null
        }
        const card = toCard(element, element.type === "mdxJsxTextElement" ? index : undefined)
        if (!card) return null
        cards.push(card)
      }
    }
    return { type: "cardGroup", attrs: { attributes, cards } }
  }

  if (node.name === "Embed") {
    return node.children.length === 0 ? { type: "embed", attrs: { attributes } } : null
  }

  // A card on its own, without a grid: the site draws it full width.
  if (node.name === "Card") {
    const card = toCard(node)
    return card ? { type: "cardGroup", attrs: { attributes: [], cards: [card], grid: false } } : null
  }

  return null
}

type JsxElement = MdxJsxFlowElement | MdxJsxTextElement

/**
 * The JSX elements among a component's children. MDX puts elements written on
 * their own line, one after another, into one paragraph as inline elements;
 * `line` numbers that paragraph, so the writer can put them back the same way.
 * Null when a child is anything but an element or whitespace.
 */
function jsxChildren(children: readonly RootContent[]): { element: JsxElement; line?: number }[] | null {
  const elements: { element: JsxElement; line?: number }[] = []
  for (const [index, child] of children.entries()) {
    if (child.type === "mdxJsxFlowElement") {
      elements.push({ element: child })
      continue
    }
    if (child.type !== "paragraph") return null
    for (const part of child.children) {
      if (part.type === "text" && part.value.trim() === "") continue
      if (part.type !== "mdxJsxTextElement") return null
      elements.push({ element: part, line: index })
    }
  }
  return elements
}

/** An element's body as editor blocks: its inline text as one paragraph, or its blocks. */
function toEditorBody(element: JsxElement): JSONContent[] | null {
  if (element.type === "mdxJsxTextElement") {
    const inline = toEditorInline(element.children as PhrasingContent[], [])
    return inline ? [{ type: "paragraph", ...(inline.length > 0 ? { content: inline } : {}) }] : null
  }
  const content = toEditorChildren(element.children as BlockContent[])
  return content ? (content.length > 0 ? content : [{ type: "paragraph" }]) : null
}

function toEditorSteps(node: MdxJsxFlowElement, attributes: MdxAttribute[]): JSONContent | null {
  const elements = jsxChildren(node.children as RootContent[])
  if (!elements || elements.length === 0) return null
  const items: JSONContent[] = []
  for (const { element, line } of elements) {
    if (element.name !== "StepItem") return null
    const itemAttributes = plainAttributes(element)
    const body = toEditorBody(element)
    if (!itemAttributes || !body) return null
    const title = itemAttributes.find(({ name }) => name === "title")?.value ?? ""
    items.push({
      type: "stepItem",
      attrs: { attributes: itemAttributes, line: line ?? null },
      content: [
        { type: "stepTitle", ...(title ? { content: [{ type: "text", text: title }] } : {}) },
        { type: "stepBody", content: body },
      ],
    })
  }
  return { type: "steps", attrs: { attributes }, content: items }
}

/**
 * `<Tabs>` with one `<TabsList>` of `<TabsTrigger>`s and a `<TabsContent>` for
 * each trigger's value. Tabs follow the trigger order.
 */
function toEditorTabs(node: MdxJsxFlowElement, attributes: MdxAttribute[]): JSONContent | null {
  const elements = jsxChildren(node.children as RootContent[])
  if (!elements) return null
  const lists = elements.filter(({ element }) => element.name === "TabsList")
  const contents = elements.filter(({ element }) => element.name === "TabsContent")
  if (lists.length !== 1 || lists.length + contents.length !== elements.length) return null
  const list = lists[0].element
  const listAttributes = plainAttributes(list)
  const triggers = jsxChildren(list.children as RootContent[])
  if (!listAttributes || !triggers || triggers.length === 0 || triggers.length !== contents.length) return null

  const items: JSONContent[] = []
  for (const { element: trigger } of triggers) {
    const triggerAttributes = trigger.name === "TabsTrigger" ? plainAttributes(trigger) : null
    const value = triggerAttributes?.find(({ name }) => name === "value")?.value
    const label = plainText(trigger.children as RootContent[])
    if (!triggerAttributes || !value || label === null) return null
    const placed = contents.find(({ element }) =>
      element.attributes.some((attribute) => attribute.type === "mdxJsxAttribute" && attribute.name === "value" && attribute.value === value),
    )
    const contentAttributes = placed ? plainAttributes(placed.element) : null
    const body = placed ? toEditorBody(placed.element) : null
    if (!placed || !contentAttributes || !body) return null
    items.push({
      type: "tabItem",
      attrs: { label, value, triggerAttributes, contentAttributes, line: placed.line ?? null },
      content: body,
    })
  }
  return { type: "tabs", attrs: { attributes, listAttributes }, content: items }
}

/** The plain text of inline children, or null when they hold more than text. */
function plainText(children: readonly RootContent[]): string | null {
  let text = ""
  for (const child of children) {
    if (child.type === "text") text += child.value
    else if (child.type === "paragraph") {
      const inner = plainText(child.children as RootContent[])
      if (inner === null) return null
      text += inner
    } else return null
  }
  return text.trim()
}

function toFileTreeItems(children: readonly RootContent[]): FileTreeItem[] | null {
  const elements = jsxChildren(children)
  if (!elements) return null
  const items: FileTreeItem[] = []
  for (const { element } of elements) {
    const attributes = plainAttributes(element)
    if (!attributes || !attributes.some(({ name }) => name === "name")) return null
    if (element.name === "File" && element.children.length === 0) {
      items.push({ kind: "file", attributes })
    } else if (element.name === "Folder") {
      const nested = toFileTreeItems(element.children as RootContent[])
      if (!nested) return null
      items.push({ kind: "folder", attributes, children: nested })
    } else {
      return null
    }
  }
  return items
}

/**
 * A diagram. The chart is a plain string (`chart="…"`) or a template literal
 * without substitutions (`` chart={`…`} ``), which is what the documentation
 * agent writes. Every other attribute must be plain.
 */
function toEditorMermaid(node: MdxJsxFlowElement): JSONContent | null {
  if (node.children.length > 0) return null
  const attributes: MdxAttribute[] = []
  let chart: string | null = null
  for (const attribute of node.attributes) {
    if (attribute.type !== "mdxJsxAttribute") return null
    if (attribute.name === "chart") {
      const { value } = attribute
      // The same reading the renderer applies, so the editor shows the chart it draws.
      chart = typeof value === "string" ? value : value ? readStringLiteral(value.value.trim()) : null
      if (chart === null) return null
      continue
    }
    if (attribute.value !== null && typeof attribute.value !== "string") return null
    attributes.push({ name: attribute.name, value: attribute.value ?? null })
  }
  return chart === null ? null : { type: "mermaid", attrs: { chart, attributes } }
}

/** Attributes as name/value pairs, or null when any carries code. */
function plainAttributes(node: MdxJsxFlowElement | MdxJsxTextElement): MdxAttribute[] | null {
  const attributes: MdxAttribute[] = []
  for (const attribute of node.attributes) {
    if (attribute.type !== "mdxJsxAttribute") return null
    const { value } = attribute
    if (value === null || value === undefined || typeof value === "string") {
      attributes.push({ name: attribute.name, value: value ?? null })
      continue
    }
    const literal = literalExpression(value.value)
    if (literal === null) return null
    attributes.push({ name: attribute.name, value: literal, expression: true })
  }
  return attributes
}

/** `true`, `false` or a number: an expression the renderer reads as a value. */
function literalExpression(expression: string): string | null {
  const trimmed = expression.trim()
  return /^(true|false|-?\d+(\.\d+)?)$/.test(trimmed) ? trimmed : null
}

/** Node types that carry JavaScript or raw HTML. */
const CODE_TYPES = new Set([
  "mdxFlowExpression",
  "mdxTextExpression",
  "mdxjsEsm",
  "mdxJsxAttributeValueExpression",
  "mdxJsxExpressionAttribute",
  "html",
])

/**
 * True when a node carries code the editor cannot model. A literal attribute
 * value (`external={true}`) is data, not code, so it does not count.
 */
function containsJavaScript(node: unknown): boolean {
  if (typeof node !== "object" || node === null) return false
  const record = node as Record<string, unknown>
  if (
    record.type === "mdxJsxAttribute" &&
    typeof record.value === "object" &&
    record.value !== null &&
    literalExpression(String((record.value as { value?: unknown }).value ?? "")) !== null
  ) {
    return false
  }
  if (typeof record.type === "string" && CODE_TYPES.has(record.type)) return true
  for (const key of ["attributes", "children"] as const) {
    const list = record[key]
    if (Array.isArray(list) && list.some(containsJavaScript)) return true
  }
  return typeof record.value === "object" && containsJavaScript(record.value)
}

/**
 * A card's body: its text, null when it has none, undefined when it holds more
 * than one paragraph. Text with inline Markdown keeps its Markdown source.
 */
function cardBody(card: MdxJsxFlowElement | MdxJsxTextElement): { body: string | null; markdown?: true } | undefined {
  if (card.children.length === 0) return { body: null }
  // `<Card>text</Card>` on one line holds its inline content directly.
  const inline: PhrasingContent[] | null =
    card.type === "mdxJsxTextElement" || (card.children as unknown as PhrasingContent[]).every((child) => child.type === "text")
      ? (card.children as unknown as PhrasingContent[])
      : card.children.length === 1 && card.children[0].type === "paragraph"
        ? card.children[0].children
        : null
  if (!inline) return undefined
  if (inline.every((child) => child.type === "text")) {
    return { body: inline.map((child) => (child.type === "text" ? child.value : "")).join("") }
  }
  // Only Markdown the editor can model: no JSX or code inside the text.
  if (!toEditorInline(inline, [])) return undefined
  return { body: stringifyMdxTree({ type: "root", children: [{ type: "paragraph", children: inline }] }).trim(), markdown: true }
}

/**
 * One-line cards on neighbouring lines, without a grid: MDX reads them as one
 * paragraph of inline `<Card>`s.
 */
function toEditorLooseCards(children: readonly PhrasingContent[]): JSONContent | null {
  const cards: MdxCard[] = []
  for (const child of children) {
    if (child.type === "text" && child.value.trim() === "") continue
    if (child.type !== "mdxJsxTextElement" || child.name !== "Card") return null
    const card = toCard(child, 0)
    if (!card) return null
    cards.push(card)
  }
  return cards.length > 0 ? { type: "cardGroup", attrs: { attributes: [], cards, grid: false } } : null
}

/** A card from its element, or null when it holds what a card cannot model. */
function toCard(element: MdxJsxFlowElement | MdxJsxTextElement, line?: number): MdxCard | null {
  const attributes = plainAttributes(element)
  const body = cardBody(element)
  if (!attributes || !body) return null
  return { attributes, ...body, ...(line !== undefined ? { line } : {}) }
}

/**
 * An image alone on its line. Only a source the site renders becomes an image
 * block: an `https` address or a path on the docs host such as `/assets/…`.
 * Any other image, or one inside a line of text, stays a locked block.
 */
function toEditorImage(children: readonly PhrasingContent[]): JSONContent | null {
  const parts = children.filter((child) => !(child.type === "text" && child.value.trim() === ""))
  const [image] = parts
  if (parts.length !== 1 || image?.type !== "image" || !isRenderableImageSource(image.url)) return null
  return { type: "image", attrs: { src: image.url, alt: image.alt ?? "", title: image.title ?? null } }
}

/** The sources the docs renderer draws: `http(s)` addresses and root-relative paths. */
export function isRenderableImageSource(url: string): boolean {
  return /^(https?:\/\/|\/(?!\/))/i.test(url)
}

function toEditorInline(nodes: PhrasingContent[], marks: Mark[]): JSONContent[] | null {
  const content: JSONContent[] = []
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        if (node.value) content.push({ type: "text", text: node.value, ...(marks.length > 0 ? { marks } : {}) })
        break
      case "strong":
      case "emphasis":
      case "delete": {
        const mark = { type: node.type === "strong" ? "bold" : node.type === "emphasis" ? "italic" : "strike" }
        const inner = toEditorInline(node.children, [...marks, mark])
        if (!inner) return null
        content.push(...inner)
        break
      }
      case "inlineCode":
        // The editor's code mark excludes every other mark.
        if (marks.length > 0) return null
        if (node.value) content.push({ type: "text", text: node.value, marks: [{ type: "code" }] })
        break
      case "link": {
        if (node.title) return null
        const inner = toEditorInline(node.children, [...marks, { type: "link", attrs: { href: node.url } }])
        if (!inner) return null
        content.push(...inner)
        break
      }
      case "break":
        content.push({ type: "hardBreak" })
        break
      default:
        return null
    }
  }
  return content
}

// ─── editor → MDX ──────────────────────────────────────────────────────────

function fromEditorBlock(node: JSONContent): RootContent | null {
  const children = node.content ?? []
  switch (node.type) {
    case "paragraph":
      return { type: "paragraph", children: fromEditorInline(children) }
    case "heading":
      return {
        type: "heading",
        depth: clampDepth(Number(node.attrs?.level ?? 2)),
        children: fromEditorInline(children),
      }
    case "horizontalRule":
      return { type: "thematicBreak" }
    case "codeBlock":
      return {
        type: "code",
        lang: (node.attrs?.language as string | null) || null,
        meta: (node.attrs?.meta as string | null) || null,
        value: children.map((child) => child.text ?? "").join(""),
      }
    case "bulletList":
    case "orderedList":
      return {
        type: "list",
        ordered: node.type === "orderedList",
        start: node.type === "orderedList" ? Number(node.attrs?.start ?? 1) : null,
        spread: Boolean(node.attrs?.spread),
        children: children.map((item) => ({
          type: "listItem",
          spread: Boolean(item.attrs?.spread),
          checked: null,
          children: (item.content ?? []).flatMap((child) => {
            const block = fromEditorBlock(child)
            return block ? [block as BlockContent] : []
          }),
        })),
      }
    case "callout":
      return {
        type: "mdxJsxFlowElement",
        name: "Note",
        attributes: toMdxAttributes(node.attrs?.attributes),
        children: children.flatMap((child) => {
          const block = fromEditorBlock(child)
          return block ? [block as BlockContent] : []
        }),
      }
    case "cardGroup": {
      const cards = (node.attrs?.cards ?? []) as MdxCard[]
      // Cards written without a grid go back without one.
      const loose = node.attrs?.grid === false ? cardChildren(cards) : []
      if (loose.length === 1) return loose[0]
      return {
        type: "mdxJsxFlowElement",
        name: "CardGrid",
        attributes: toMdxAttributes(node.attrs?.attributes),
        children: cardChildren(cards),
      }
    }
    case "blockquote":
      return {
        type: "blockquote",
        children: children.flatMap((child) => {
          const block = fromEditorBlock(child)
          return block ? [block as BlockContent] : []
        }),
      }
    case "table":
      return fromEditorTable(children)
    case "steps":
      return {
        type: "mdxJsxFlowElement",
        name: "Step",
        attributes: toMdxAttributes(node.attrs?.attributes),
        children: placeElements(children.map(stepItemElement)),
      }
    case "tabs":
      return tabsElement(node)
    case "fileTree":
      return {
        type: "mdxJsxFlowElement",
        name: "FileTree",
        attributes: toMdxAttributes(node.attrs?.attributes),
        children: fileTreeElements((node.attrs?.items ?? []) as FileTreeItem[]),
      }
    case "mermaid":
      return {
        type: "mdxJsxFlowElement",
        name: "Mermaid",
        attributes: [
          {
            type: "mdxJsxAttribute",
            name: "chart",
            value: { type: "mdxJsxAttributeValueExpression", value: chartTemplate(String(node.attrs?.chart ?? "")) },
          },
          ...toMdxAttributes(node.attrs?.attributes),
        ],
        children: [],
      }
    case "image": {
      // An image still uploading or waiting for a file has no source and is not saved.
      const src = String(node.attrs?.src ?? "")
      if (!src) return null
      return {
        type: "paragraph",
        children: [
          {
            type: "image",
            url: src,
            alt: String(node.attrs?.alt ?? ""),
            title: (node.attrs?.title as string | null) || null,
          },
        ],
      }
    }
    case "embed":
      // An embed still waiting for its link is not saved.
      if (!(node.attrs?.attributes as MdxAttribute[] | undefined)?.some((a) => a.name === "url" && a.value)) return null
      return {
        type: "mdxJsxFlowElement",
        name: "Embed",
        attributes: toMdxAttributes(node.attrs?.attributes),
        children: [],
      }
    case "mdxBlock":
      // The serializer writes a raw node's value as it is.
      return { type: "html", value: String(node.attrs?.source ?? "") }
    default:
      return null
  }
}

/** An element written on its own, or inline in the paragraph `line` it shared. */
type PlacedElement = { flow: MdxJsxFlowElement } | { inline: MdxJsxTextElement; line: number }

/** Elements back into a component's children. Inline ones of one line share a paragraph again. */
function placeElements(elements: PlacedElement[]): BlockContent[] {
  const children: BlockContent[] = []
  let line: number | undefined
  for (const placed of elements) {
    if ("flow" in placed) {
      children.push(placed.flow)
      line = undefined
      continue
    }
    const previous = children.at(-1)
    if (line === placed.line && previous?.type === "paragraph") {
      previous.children.push({ type: "text", value: "\n" }, placed.inline)
    } else {
      children.push({ type: "paragraph", children: [placed.inline] })
    }
    line = placed.line
  }
  return children
}

/** Editor blocks back to MDX blocks. Empty paragraphs are left out. */
function blocksOf(nodes: readonly JSONContent[]): BlockContent[] {
  return nodes.flatMap((child) => {
    if (isEmptyParagraph(child)) return []
    const block = fromEditorBlock(child)
    return block ? [block as BlockContent] : []
  })
}

/** Sets one attribute, keeping its place; an empty value removes it. */
function withAttribute(attributes: readonly MdxAttribute[], name: string, value: string): MdxAttribute[] {
  const index = attributes.findIndex((attribute) => attribute.name === name)
  if (!value) return attributes.filter((_, position) => position !== index)
  if (index === -1) return [{ name, value }, ...attributes]
  return attributes.map((attribute, position) => (position === index ? { name, value } : attribute))
}

function stepItemElement(item: JSONContent): PlacedElement {
  const [title, body] = item.content ?? []
  const attributes = toMdxAttributes(
    withAttribute((item.attrs?.attributes ?? []) as MdxAttribute[], "title", (title?.content ?? []).map((part) => part.text ?? "").join("").trim()),
  )
  const blocks = blocksOf(body?.content ?? [])
  const line = item.attrs?.line
  // A one-line step stays one line while its body is one paragraph.
  if (typeof line === "number" && blocks.length === 1 && blocks[0].type === "paragraph") {
    return { inline: { type: "mdxJsxTextElement", name: "StepItem", attributes, children: blocks[0].children }, line }
  }
  return { flow: { type: "mdxJsxFlowElement", name: "StepItem", attributes, children: blocks } }
}

/**
 * Tabs back to `<Tabs>`, `<TabsList>` of triggers, and one `<TabsContent>`
 * per tab. A tab keeps its value when its label changes. `defaultValue`
 * follows the first tab when the tab it named is gone.
 */
function tabsElement(node: JSONContent): MdxJsxFlowElement {
  const items = node.content ?? []
  const used = new Set<string>()
  const values = items.map((item, index) => {
    const base = String(item.attrs?.value || slugify(String(item.attrs?.label ?? "")) || `tab-${index + 1}`)
    let value = base
    for (let suffix = 2; used.has(value); suffix += 1) value = `${base}-${suffix}`
    used.add(value)
    return value
  })

  let attributes = (node.attrs?.attributes ?? []) as MdxAttribute[]
  const defaultValue = attributes.find(({ name }) => name === "defaultValue")
  const controlled = attributes.some(({ name }) => name === "value")
  if (values.length > 0 && !controlled && (!defaultValue || !values.includes(defaultValue.value ?? ""))) {
    attributes = defaultValue
      ? attributes.map((attribute) => (attribute.name === "defaultValue" ? { name: "defaultValue", value: values[0] } : attribute))
      : [{ name: "defaultValue", value: values[0] }, ...attributes]
  }

  const triggers: PlacedElement[] = items.map((item, index) => ({
    inline: {
      type: "mdxJsxTextElement",
      name: "TabsTrigger",
      attributes: toMdxAttributes(withAttribute((item.attrs?.triggerAttributes ?? []) as MdxAttribute[], "value", values[index])),
      children: [{ type: "text", value: String(item.attrs?.label ?? "") || `Tab ${index + 1}` }],
    },
    line: 0,
  }))
  const panels = items.map((item, index): PlacedElement => {
    const attributes = toMdxAttributes(withAttribute((item.attrs?.contentAttributes ?? []) as MdxAttribute[], "value", values[index]))
    const blocks = blocksOf(item.content ?? [])
    const line = item.attrs?.line
    // A one-line panel stays one line while its content is one paragraph.
    if (typeof line === "number" && blocks.length === 1 && blocks[0].type === "paragraph") {
      return { inline: { type: "mdxJsxTextElement", name: "TabsContent", attributes, children: blocks[0].children }, line }
    }
    return { flow: { type: "mdxJsxFlowElement", name: "TabsContent", attributes, children: blocks } }
  })

  return {
    type: "mdxJsxFlowElement",
    name: "Tabs",
    attributes: toMdxAttributes(attributes),
    children: [
      {
        type: "mdxJsxFlowElement",
        name: "TabsList",
        attributes: toMdxAttributes(node.attrs?.listAttributes),
        children: placeElements(triggers),
      },
      ...placeElements(panels),
    ],
  }
}

/** A tab value from its label: `npm install` becomes `npm-install`. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function fileTreeElements(items: readonly FileTreeItem[]): BlockContent[] {
  return items.map((item) => ({
    type: "mdxJsxFlowElement",
    name: item.kind === "folder" ? "Folder" : "File",
    attributes: toMdxAttributes(item.attributes),
    children: item.kind === "folder" ? fileTreeElements(item.children ?? []) : [],
  }))
}

/**
 * A chart as a template literal. The MDX parser removes up to two spaces from
 * each continuation line of an attribute expression, at any depth, so each
 * continuation line gets two here: the renderer then reads the chart exactly.
 */
function chartTemplate(chart: string): string {
  const escaped = chart.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${")
  const [first = "", ...rest] = escaped.split("\n")
  return `\`${[first, ...rest.map((line) => (line ? `  ${line}` : line))].join("\n")}\``
}

function fromEditorTable(rows: JSONContent[]): Table {
  const header = rows[0]?.content ?? []
  return {
    type: "table",
    align: header.map((cell) => (cell.attrs?.align as AlignType | undefined) ?? null),
    children: rows.map(
      (row): TableRow => ({
        type: "tableRow",
        children: (row.content ?? []).map(
          (cell): TableCell => ({
            type: "tableCell",
            // A GFM cell is one line, so a line break becomes a space.
            children: fromEditorInline(
              (cell.content?.[0]?.content ?? []).map((item) =>
                item.type === "hardBreak" ? { type: "text", text: " " } : item,
              ),
            ),
          }),
        ),
      }),
    ),
  }
}

/** A card's body as inline MDX: parsed when it is Markdown, text otherwise. */
function cardInline(card: MdxCard): PhrasingContent[] {
  const body = card.body ?? ""
  if (card.markdown) {
    const [first] = parseMdxTree(body).children
    if (first?.type === "paragraph") return first.children
  }
  return [{ type: "text", value: body }]
}

/** Cards back to JSX. One-line cards that shared a paragraph share it again. */
function cardChildren(cards: MdxCard[]): BlockContent[] {
  return placeElements(
    cards.map((card): PlacedElement => {
      const attributes = toMdxAttributes(card.attributes)
      if (card.line === undefined) {
        return {
          flow: {
            type: "mdxJsxFlowElement",
            name: "Card",
            attributes,
            children: card.body ? [{ type: "paragraph", children: cardInline(card) }] : [],
          },
        }
      }
      return {
        inline: { type: "mdxJsxTextElement", name: "Card", attributes, children: card.body ? cardInline(card) : [] },
        line: card.line,
      }
    }),
  )
}

function toMdxAttributes(value: unknown): MdxJsxAttribute[] {
  if (!Array.isArray(value)) return []
  return (value as MdxAttribute[]).map((attribute) => ({
    type: "mdxJsxAttribute",
    name: attribute.name,
    value:
      attribute.expression && attribute.value !== null
        ? { type: "mdxJsxAttributeValueExpression", value: attribute.value }
        : attribute.value,
  }))
}

type InlineItem = JSONContent

/** Marks that wrap, in nesting order from the outside in. */
const WRAPPING_MARKS = ["link", "bold", "italic", "strike"] as const

function fromEditorInline(items: InlineItem[]): PhrasingContent[] {
  const out: PhrasingContent[] = []
  let index = 0
  while (index < items.length) {
    const item = items[index]
    const mark = WRAPPING_MARKS.map((type) => item.marks?.find((candidate) => candidate.type === type)).find(Boolean)
    if (!mark) {
      out.push(toLeaf(item))
      index += 1
      continue
    }
    // Consecutive items with the same mark share one wrapper, so the output
    // reads **a b** and not **a****b**.
    const run: InlineItem[] = []
    while (index < items.length && hasMark(items[index], mark)) {
      run.push(withoutMark(items[index], mark))
      index += 1
    }
    out.push(wrap(mark, fromEditorInline(run)))
  }
  return out
}

function hasMark(item: InlineItem, mark: Mark): boolean {
  return Boolean(
    item.marks?.some(
      (candidate) => candidate.type === mark.type && candidate.attrs?.href === mark.attrs?.href,
    ),
  )
}

function withoutMark(item: InlineItem, mark: Mark): InlineItem {
  return { ...item, marks: item.marks?.filter((candidate) => candidate.type !== mark.type) }
}

function wrap(mark: Mark, children: PhrasingContent[]): PhrasingContent {
  switch (mark.type) {
    case "link":
      return { type: "link", url: String(mark.attrs?.href ?? ""), title: null, children }
    case "bold":
      return { type: "strong", children }
    case "italic":
      return { type: "emphasis", children }
    default:
      return { type: "delete", children }
  }
}

function toLeaf(item: InlineItem): PhrasingContent {
  if (item.type === "hardBreak") return { type: "break" }
  const text = item.text ?? ""
  if (item.marks?.some((mark) => mark.type === "code")) return { type: "inlineCode", value: text }
  return { type: "text", value: text }
}

function clampDepth(level: number): 1 | 2 | 3 | 4 | 5 | 6 {
  return Math.min(6, Math.max(1, Math.round(level))) as 1 | 2 | 3 | 4 | 5 | 6
}

// ─── helpers ───────────────────────────────────────────────────────────────

function blockIdOf(node: JSONContent): number | null {
  const id = node.attrs?.blockId
  return typeof id === "number" ? id : null
}

function isEmptyParagraph(node: JSONContent): boolean {
  return node.type === "paragraph" && !(node.content && node.content.length > 0)
}

/**
 * Sets one frontmatter key, keeping every other line as it is. A value is
 * quoted when YAML would misread it, and keeps its old quote style otherwise.
 */
export function setFrontmatterField(head: string, key: string, value: string): string {
  if (!head) {
    return value ? `---\n${key}: ${yamlValue(value, null)}\n---\n` : head
  }
  const newline = head.includes("\r\n") ? "\r\n" : "\n"
  const lines = head.split(newline)
  const closing = lines.indexOf("---", 1)
  const index = lines.findIndex((line, lineIndex) => lineIndex > 0 && lineIndex < closing && line.startsWith(`${key}:`))
  if (index === -1) {
    if (!value) return head
    lines.splice(closing, 0, `${key}: ${yamlValue(value, null)}`)
    return lines.join(newline)
  }
  // Drop the continuation lines of a folded or block value.
  let end = index + 1
  while (end < closing && /^\s+/.test(lines[end] ?? "")) end += 1
  const previous = lines[index].slice(key.length + 1).trim()
  lines.splice(index, end - index, `${key}: ${yamlValue(value, previous)}`)
  return lines.join(newline)
}

function yamlValue(value: string, previous: string | null): string {
  if (previous?.startsWith("'")) return `'${value.replace(/'/g, "''")}'`
  const needsQuotes =
    previous?.startsWith('"') ||
    value === "" ||
    /^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(value) ||
    /:\s|\s#/.test(value) ||
    /\s$/.test(value) ||
    /^(true|false|null|yes|no|on|off|~|-?\d+(\.\d+)?)$/i.test(value)
  return needsQuotes ? JSON.stringify(value) : value
}
