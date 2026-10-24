
import type { MdxAttribute } from "~/lib/editor/mdx-document"

/**
 * The props an author can set on each docs component in the Write editor.
 *
 * One definition per prop drives the form that edits it, the value the form
 * shows, and the attribute written back to MDX. The names and defaults are the
 * ones the shared components in `@doxahq/docs-prose` read.
 */

interface PropFieldBase {
  name: string
  label: string
  description?: string
  /** The group the field sits in, in a form with several groups. */
  section?: string
  /** Shows the field only while another prop has this value. */
  visibleWhen?: { name: string; value: string }
}

export type PropField =
  | (PropFieldBase & { kind: "text"; placeholder?: string; multiline?: boolean })
  | (PropFieldBase & { kind: "link"; placeholder?: string })
  | (PropFieldBase & { kind: "enum"; options: readonly { value: string; label: string }[]; defaultValue: string })
  | (PropFieldBase & { kind: "icon" })
  | (PropFieldBase & { kind: "boolean" })

/** A prop value as a form holds it. */
export type PropValue = string | boolean

export const NOTE_TYPES = ["note", "success", "warning", "danger"] as const

export const NOTE_PROPS: readonly PropField[] = [
  {
    name: "type",
    label: "Type",
    kind: "enum",
    options: [
      { value: "note", label: "Note" },
      { value: "success", label: "Success" },
      { value: "warning", label: "Warning" },
      { value: "danger", label: "Danger" },
    ],
    defaultValue: "note",
  },
  { name: "title", label: "Title", kind: "text", placeholder: "Note" },
]

/**
 * Card props in the order the settings show them. `subtitle` and `image` are
 * drawn only by the style that uses them, so they show only with that style.
 */
export const CARD_PROPS: readonly PropField[] = [
  { name: "title", label: "Title", kind: "text", section: "Content", placeholder: "Card title" },
  {
    name: "description",
    label: "Description",
    kind: "text",
    section: "Content",
    multiline: true,
    placeholder: "What the reader finds there",
  },
  {
    name: "subtitle",
    label: "Subtitle",
    kind: "text",
    section: "Content",
    placeholder: "Shown above the title",
    visibleWhen: { name: "variant", value: "normal" },
  },
  { name: "href", label: "Link", kind: "link", section: "Link", placeholder: "/page or https://…" },
  {
    name: "external",
    label: "External link",
    kind: "boolean",
    section: "Link",
    description: "Adds an arrow to show that the link leaves the docs.",
  },
  {
    name: "variant",
    label: "Style",
    kind: "enum",
    section: "Appearance",
    options: [
      { value: "normal", label: "Normal" },
      { value: "small", label: "Small" },
      { value: "image", label: "Image" },
    ],
    defaultValue: "normal",
  },
  { name: "icon", label: "Icon", kind: "icon", section: "Appearance" },
  {
    name: "image",
    label: "Image URL",
    kind: "link",
    section: "Appearance",
    placeholder: "https://…",
    visibleWhen: { name: "variant", value: "image" },
  },
]

/** The link of an `<Embed>`: a YouTube, Vimeo or Loom video. */
export const EMBED_URL_PROP: PropField = {
  name: "url",
  label: "Video link",
  kind: "link",
  placeholder: "https://www.youtube.com/watch?v=…",
}

/** The value a form shows for one prop. */
export function readProp(attributes: readonly MdxAttribute[], field: PropField): PropValue {
  const attribute = attributes.find(({ name }) => name === field.name)
  if (field.kind === "boolean") {
    if (!attribute) return false
    // `external` and `external={true}` are both true. `external={false}` is false.
    return attribute.value === null || attribute.value === "true"
  }
  if (field.kind === "enum") return attribute?.value ?? field.defaultValue
  return attribute?.value ?? ""
}

/**
 * The attributes with one prop set. An attribute keeps its place and form. A
 * prop set to its default or to nothing is removed, so the MDX stays as short
 * as the renderer allows.
 */
export function writeProp(attributes: readonly MdxAttribute[], field: PropField, value: PropValue): MdxAttribute[] {
  const next: MdxAttribute | null =
    field.kind === "boolean"
      ? value
        ? { name: field.name, value: "true", expression: true }
        : null
      : typeof value === "string" && value !== "" && !(field.kind === "enum" && value === field.defaultValue)
        ? { name: field.name, value }
        : null

  const index = attributes.findIndex(({ name }) => name === field.name)
  if (index === -1) return next ? [...attributes, next] : [...attributes]
  const current = attributes[index]
  if (!next) return attributes.filter((_, position) => position !== index)
  // A bare boolean attribute (`external`) stays bare.
  if (field.kind === "boolean" && current.value === null) return [...attributes]
  return attributes.map((attribute, position) => (position === index ? next : attribute))
}
