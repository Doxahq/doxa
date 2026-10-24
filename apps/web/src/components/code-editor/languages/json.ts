import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete"
import { json } from "@codemirror/lang-json"
import { HighlightStyle, syntaxHighlighting, syntaxTree } from "@codemirror/language"
import { linter, lintGutter, type Diagnostic } from "@codemirror/lint"
import type { EditorState, Extension } from "@codemirror/state"
import { EditorView, hoverTooltip } from "@codemirror/view"
import { tags } from "@lezer/highlight"
import { z } from "zod"

type SyntaxNode = ReturnType<typeof syntaxTree>["topNode"]

/** The part of a JSON Schema that completion and hover read. */
export interface JsonSchemaNode {
  type?: string | string[]
  properties?: Record<string, JsonSchemaNode>
  items?: JsonSchemaNode
  anyOf?: JsonSchemaNode[]
  enum?: unknown[]
  default?: unknown
  maxLength?: number
  maxItems?: number
}

const jsonSchemaNodeSchema: z.ZodType<JsonSchemaNode> = z.lazy(() =>
  z.object({
    type: z.union([z.string(), z.array(z.string())]).optional(),
    properties: z.record(z.string(), jsonSchemaNodeSchema).optional(),
    items: jsonSchemaNodeSchema.optional(),
    anyOf: z.array(jsonSchemaNodeSchema).optional(),
    enum: z.array(z.unknown()).optional(),
    default: z.unknown().optional(),
    maxLength: z.number().optional(),
    maxItems: z.number().optional(),
  }),
)

/** Reads a generated JSON Schema. Unknown keywords are ignored. */
export function toJsonSchemaNode(schema: unknown): JsonSchemaNode {
  return jsonSchemaNodeSchema.parse(schema)
}

/** A problem to show in the editor, addressed by JSON pointer. */
export interface JsonDiagnosticIssue {
  path: string
  code: string
  severity: "error" | "warning"
  message: string
}

export interface JsonLanguageOptions {
  schema: JsonSchemaNode
  /** Returns every issue for the text. Called after typing stops. */
  diagnose: (text: string) => readonly JsonDiagnosticIssue[]
}

export interface JsonRange {
  from: number
  to: number
}

/**
 * JSON editing with the site settings rules.
 *
 * The lint source is the caller's `diagnose`, so the editor shows the exact
 * issues and messages that the form shows. Completion and hover read the
 * JSON Schema that `@doxahq/site-config` generates.
 */
export function createJsonLanguage({ schema, diagnose }: JsonLanguageOptions): Extension {
  return [
    json(),
    syntaxHighlighting(jsonHighlightStyle),
    jsonEditorTheme,
    lintGutter(),
    linter((view) => toDiagnostics(view.state, diagnose(view.state.doc.toString())), {
      delay: 300,
    }),
    autocompletion({ override: [(context) => completeFromSchema(context, schema)] }),
    hoverTooltip((view, position) => describeSchemaAt(view.state, position, schema)),
  ]
}

/**
 * Finds the text range of a JSON pointer.
 *
 * `target: "key"` returns the property name, for issues about a key itself.
 * A pointer that does not exist resolves to the deepest node that does, so a
 * missing value still points at the object that must contain it.
 */
export function locateJsonPointer(
  state: EditorState,
  pointer: string,
  target: "key" | "value" = "value",
): JsonRange | null {
  const root = syntaxTree(state).topNode.firstChild
  if (!root) return null
  let node: SyntaxNode = root
  const segments = pointer === "" ? [] : pointer.slice(1).split("/").map(decodePointerSegment)

  for (const [index, segment] of segments.entries()) {
    const isLast = index === segments.length - 1
    if (node.name === "Object") {
      const property = childNodes(node).find(
        (child) => child.name === "Property" && propertyName(state, child) === segment,
      )
      if (!property) return rangeOf(node)
      const name = property.getChild("PropertyName")
      if (isLast && target === "key" && name) return rangeOf(name)
      const propertyNode = propertyValue(property)
      if (!propertyNode) return rangeOf(property)
      node = propertyNode
    } else if (node.name === "Array") {
      const item: SyntaxNode | undefined = arrayValues(node)[Number(segment)]
      if (!item) return rangeOf(node)
      node = item
    } else {
      return rangeOf(node)
    }
  }
  return rangeOf(node)
}

function toDiagnostics(
  state: EditorState,
  issues: readonly JsonDiagnosticIssue[],
): Diagnostic[] {
  return issues.map((issue) => {
    const range =
      issue.code === "invalid_json"
        ? firstSyntaxError(state)
        : (locateJsonPointer(state, issue.path, issue.code === "unknown_key" ? "key" : "value") ??
          { from: 0, to: 0 })
    return { ...range, severity: issue.severity, message: issue.message }
  })
}

function firstSyntaxError(state: EditorState): JsonRange {
  let found: JsonRange | null = null
  syntaxTree(state).iterate({
    enter: (node) => {
      if (found) return false
      if (node.type.isError) found = { from: node.from, to: Math.max(node.to, node.from) }
      return undefined
    },
  })
  const end = state.doc.length
  return found ?? { from: end, to: end }
}

export function completeFromSchema(
  context: CompletionContext,
  schema: JsonSchemaNode,
): CompletionResult | null {
  const node = syntaxTree(context.state).resolveInner(context.pos, -1)
  const word = context.matchBefore(/"?[\w$-]*/)
  const from = word?.from ?? context.pos

  // A key position: an object body, the brace or comma before a new key, or
  // the name of a property being typed.
  const objectNode =
    node.name === "Object"
      ? node
      : KEY_POSITION_TOKENS.has(node.name) && node.parent?.name === "Object"
        ? node.parent
        : node.name === "PropertyName" && node.parent?.parent?.name === "Object"
          ? node.parent.parent
          : null
  if (objectNode) {
    const objectSchema = schemaAt(schema, pathOf(context.state, objectNode))
    const properties = objectSchema?.properties
    if (!properties) return null
    const present = new Set(
      childNodes(objectNode)
        .filter((child) => child.name === "Property" && child.getChild("PropertyName") !== node)
        .map((child) => propertyName(context.state, child)),
    )
    const options: Completion[] = Object.entries(properties)
      .filter(([key]) => !present.has(key))
      .map(([key, child]) => ({
        label: JSON.stringify(key),
        apply: `${JSON.stringify(key)}: `,
        detail: typeLabel(child),
        type: "property",
      }))
    return { from, options, validFor: /^"?[\w$-]*$/ }
  }

  // A value position: right after the colon of a property.
  const property =
    node.name === "Property" ? node : node.parent?.name === "Property" ? node.parent : null
  if (!property || node.name === "PropertyName") return null
  const valueSchema = schemaAt(schema, [...pathOf(context.state, property), propertyName(context.state, property)])
  const values = valueSchema ? allowedValues(valueSchema) : []
  if (values.length === 0) return null
  return {
    from,
    options: values.map((value) => ({ label: JSON.stringify(value), type: "constant" })),
    validFor: /^"?[\w$ -]*"?$/,
  }
}

function describeSchemaAt(state: EditorState, position: number, schema: JsonSchemaNode) {
  const node = syntaxTree(state).resolveInner(position, 1)
  if (node.name !== "PropertyName" || !node.parent) return null
  const property = node.parent
  const path = [...pathOf(state, property), propertyName(state, property)]
  const target = schemaAt(schema, path)
  if (!target) return null
  return {
    pos: node.from,
    end: node.to,
    above: true,
    create: () => {
      const dom = document.createElement("div")
      dom.className = "cm-schema-hover"
      const lines = [
        `Type: ${typeLabel(target)}`,
        target.default !== undefined ? `Default: ${JSON.stringify(target.default)}` : null,
        allowedValues(target).length > 0
          ? `Values: ${allowedValues(target).map((value) => JSON.stringify(value)).join(", ")}`
          : null,
        target.maxLength !== undefined ? `Maximum length: ${target.maxLength}` : null,
        target.maxItems !== undefined ? `Maximum items: ${target.maxItems}` : null,
      ]
      for (const line of lines) {
        if (!line) continue
        const row = document.createElement("div")
        row.textContent = line
        dom.append(row)
      }
      return { dom }
    },
  }
}

/** The schema node at a path, following nullable (`anyOf`) branches. */
function schemaAt(schema: JsonSchemaNode, path: readonly string[]): JsonSchemaNode | null {
  let current: JsonSchemaNode | null = schema
  for (const segment of path) {
    if (!current) return null
    const branches: JsonSchemaNode[] = [current, ...(current.anyOf ?? [])]
    current =
      branches.map((branch) =>
        /^\d+$/.test(segment) ? branch.items : branch.properties?.[segment],
      ).find((child) => child !== undefined) ?? null
  }
  return current
}

function allowedValues(schema: JsonSchemaNode): unknown[] {
  const branches = [schema, ...(schema.anyOf ?? [])]
  const values = branches.flatMap((branch) => {
    if (branch.enum) return branch.enum
    if (branch.type === "boolean") return [true, false]
    if (branch.type === "null") return [null]
    return []
  })
  return [...new Set(values)]
}

function typeLabel(schema: JsonSchemaNode): string {
  const types = [schema, ...(schema.anyOf ?? [])].flatMap((branch) =>
    branch.type === undefined ? [] : Array.isArray(branch.type) ? branch.type : [branch.type],
  )
  return [...new Set(types)].join(" | ") || "value"
}

/**
 * The pointer segments of a node. For a property node, that is the path of
 * the object that holds it: its own key is not part of the path.
 */
function pathOf(state: EditorState, node: SyntaxNode): string[] {
  const segments: string[] = []
  let current: SyntaxNode = node
  while (current.parent) {
    const parent: SyntaxNode = current.parent
    if (parent.name === "Property" && current.name !== "PropertyName") {
      segments.unshift(propertyName(state, parent))
    } else if (parent.name === "Array") {
      segments.unshift(String(arrayValues(parent).findIndex((value) => value.from === current.from)))
    }
    current = parent
  }
  return segments
}

function propertyName(state: EditorState, property: SyntaxNode): string {
  const name = property.getChild("PropertyName")
  if (!name) return ""
  const text = state.sliceDoc(name.from, name.to)
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === "string" ? parsed : text
  } catch {
    return text.replace(/^"|"$/g, "")
  }
}

const VALUE_NODES = new Set(["Object", "Array", "String", "Number", "True", "False", "Null"])

/** Tokens after which an object expects a key. `⚠` is an error node. */
const KEY_POSITION_TOKENS = new Set(["{", ",", "⚠"])

function propertyValue(property: SyntaxNode): SyntaxNode | null {
  const value = property.lastChild
  return value && VALUE_NODES.has(value.name) ? value : null
}

function arrayValues(array: SyntaxNode): SyntaxNode[] {
  return childNodes(array).filter((child) => VALUE_NODES.has(child.name))
}

function childNodes(node: SyntaxNode): SyntaxNode[] {
  const children: SyntaxNode[] = []
  for (let child = node.firstChild; child; child = child.nextSibling) children.push(child)
  return children
}

function rangeOf(node: SyntaxNode): JsonRange {
  return { from: node.from, to: node.to }
}

function decodePointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~")
}

const jsonHighlightStyle = HighlightStyle.define([
  { tag: tags.propertyName, color: "var(--primary)" },
  { tag: tags.string, color: "var(--success)" },
  { tag: tags.number, color: "var(--warning)" },
  { tag: [tags.bool, tags.null], color: "var(--warning)", fontStyle: "italic" },
  { tag: tags.separator, color: "var(--muted-foreground)" },
  { tag: [tags.brace, tags.squareBracket], color: "var(--muted-foreground)" },
])

const jsonEditorTheme = EditorView.theme(
  {
    ".cm-tooltip": {
      backgroundColor: "var(--popover)",
      color: "var(--popover-foreground)",
      border: "1px solid var(--border)",
      fontFamily: "var(--font-sans)",
      fontSize: "12px",
    },
    ".cm-tooltip-autocomplete > ul": { fontFamily: "var(--font-mono)" },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
      backgroundColor: "color-mix(in oklch, var(--primary) 30%, transparent)",
      color: "var(--foreground)",
    },
    ".cm-completionDetail": { color: "var(--muted-foreground)", fontStyle: "normal" },
    ".cm-diagnostic": { padding: "6px 10px", borderLeftWidth: "3px" },
    ".cm-diagnostic-error": { borderLeftColor: "var(--destructive)" },
    ".cm-diagnostic-warning": { borderLeftColor: "var(--warning)" },
    ".cm-lintRange-error": {
      backgroundImage: "none",
      textDecoration: "underline wavy var(--destructive)",
      textUnderlineOffset: "3px",
    },
    ".cm-lintRange-warning": {
      backgroundImage: "none",
      textDecoration: "underline wavy var(--warning)",
      textUnderlineOffset: "3px",
    },
    ".cm-schema-hover": {
      display: "grid",
      gap: "2px",
      padding: "6px 10px",
      fontFamily: "var(--font-mono)",
      fontSize: "11px",
    },
  },
  { dark: true },
)
