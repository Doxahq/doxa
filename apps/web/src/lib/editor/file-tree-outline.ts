import type { FileTreeItem, MdxAttribute } from "~/lib/editor/mdx-document"

/**
 * A `<FileTree>` as an indented outline, one item per line:
 *
 *     src/
 *       index.ts
 *       lib/
 *     package.json
 *
 * Two spaces per level, and a folder ends with "/". A label follows a " # ":
 * `src/ # Source` shows "Source" in place of the folder name. The outline edits
 * names, labels and structure. Other attributes (`defaultOpen`) stay with the
 * item that keeps the same path.
 */

const LABEL_SEPARATOR = " # "

const INDENT = "  "

function nameOf(item: FileTreeItem): string {
  return item.attributes.find((attribute) => attribute.name === "name")?.value ?? ""
}

export function formatOutline(items: readonly FileTreeItem[], depth = 0): string {
  return items
    .map((item) => {
      const label = item.attributes.find((attribute) => attribute.name === "label")?.value
      const line = `${INDENT.repeat(depth)}${nameOf(item)}${item.kind === "folder" ? "/" : ""}${label ? `${LABEL_SEPARATOR}${label}` : ""}`
      const children = item.kind === "folder" && item.children?.length ? `\n${formatOutline(item.children, depth + 1)}` : ""
      return line + children
    })
    .join("\n")
}

export type OutlineResult = { ok: true; items: FileTreeItem[] } | { ok: false; error: string }

/** Every item's attributes by its path, such as `src/lib/`. */
function attributesByPath(items: readonly FileTreeItem[], prefix = "", into = new Map<string, MdxAttribute[]>()) {
  for (const item of items) {
    const path = `${prefix}${nameOf(item)}${item.kind === "folder" ? "/" : ""}`
    into.set(path, item.attributes)
    if (item.children) attributesByPath(item.children, path, into)
  }
  return into
}

/** The attributes with the outline's label: set, replaced, or removed when the line has none. */
function withLabel(attributes: MdxAttribute[], label: string): MdxAttribute[] {
  const rest = attributes.filter((attribute) => attribute.name !== "label")
  if (!label) return rest
  const at = attributes.findIndex((attribute) => attribute.name === "label")
  const labelled = { name: "label", value: label }
  if (at === -1) {
    const afterName = rest.findIndex((attribute) => attribute.name === "name") + 1
    return [...rest.slice(0, afterName), labelled, ...rest.slice(afterName)]
  }
  return attributes.map((attribute) => (attribute.name === "label" ? labelled : attribute))
}

export function parseOutline(text: string, previous: readonly FileTreeItem[] = []): OutlineResult {
  const kept = attributesByPath(previous)
  const root: FileTreeItem[] = []
  // Open folders from the outermost: the folder line's indent, its children,
  // its path, and the indent of its last item line.
  const stack: { indent: number; children: FileTreeItem[]; path: string; itemIndent?: number }[] = [
    { indent: -1, children: root, path: "" },
  ]

  const lines = text.replace(/\t/g, INDENT).split("\n")
  for (const [index, raw] of lines.entries()) {
    if (!raw.trim()) continue
    const indent = raw.length - raw.trimStart().length
    const separator = raw.indexOf(LABEL_SEPARATOR)
    const entry = (separator === -1 ? raw : raw.slice(0, separator)).trim()
    const label = separator === -1 ? "" : raw.slice(separator + LABEL_SEPARATOR.length).trim()
    const isFolder = entry.endsWith("/")
    const name = isFolder ? entry.slice(0, -1).trim() : entry
    if (!name) return { ok: false, error: `Line ${index + 1} has no name.` }

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop()
    const parent = stack[stack.length - 1]
    // Deeper than the item above it, but that item did not open a folder.
    if (parent.itemIndent !== undefined && indent > parent.itemIndent) {
      return { ok: false, error: `Line ${index + 1} is inside a file. Only a folder (a name that ends with "/") holds items.` }
    }
    parent.itemIndent = indent

    const path = `${parent.path}${name}${isFolder ? "/" : ""}`
    const attributes = withLabel(
      kept.get(path)?.map((attribute) => (attribute.name === "name" ? { name: "name", value: name } : attribute)) ?? [
        { name: "name", value: name },
      ],
      label,
    )
    const item: FileTreeItem = isFolder ? { kind: "folder", attributes, children: [] } : { kind: "file", attributes }
    parent.children.push(item)
    if (isFolder) stack.push({ indent, children: item.children!, path })
  }
  return { ok: true, items: root }
}
