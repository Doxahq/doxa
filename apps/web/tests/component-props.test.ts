import { describe, expect, test } from "vitest"

import { CARD_PROPS, NOTE_PROPS, readProp, writeProp, type PropField } from "~/lib/editor/component-props"
import type { MdxAttribute } from "~/lib/editor/mdx-document"

const field = (fields: readonly PropField[], name: string) => fields.find((candidate) => candidate.name === name)!

describe("component props", () => {
  test("an enum reads its default when the attribute is missing", () => {
    expect(readProp([], field(NOTE_PROPS, "type"))).toBe("note")
    expect(readProp([{ name: "type", value: "warning" }], field(NOTE_PROPS, "type"))).toBe("warning")
  })

  test("setting a prop keeps the other attributes in place", () => {
    const attributes: MdxAttribute[] = [
      { name: "title", value: "A" },
      { name: "href", value: "/a" },
    ]
    expect(writeProp(attributes, field(CARD_PROPS, "title"), "B")).toEqual([
      { name: "title", value: "B" },
      { name: "href", value: "/a" },
    ])
    expect(writeProp(attributes, field(CARD_PROPS, "icon"), "book")).toEqual([...attributes, { name: "icon", value: "book" }])
  })

  test("an empty value or the default removes the attribute", () => {
    expect(writeProp([{ name: "title", value: "A" }], field(NOTE_PROPS, "title"), "")).toEqual([])
    expect(writeProp([{ name: "type", value: "danger" }], field(NOTE_PROPS, "type"), "note")).toEqual([])
    expect(writeProp([], field(NOTE_PROPS, "type"), "note")).toEqual([])
  })

  test("a boolean reads every true form and writes a literal", () => {
    const external = field(CARD_PROPS, "external")
    expect(readProp([{ name: "external", value: null }], external)).toBe(true)
    expect(readProp([{ name: "external", value: "true", expression: true }], external)).toBe(true)
    expect(readProp([{ name: "external", value: "false", expression: true }], external)).toBe(false)
    expect(writeProp([], external, true)).toEqual([{ name: "external", value: "true", expression: true }])
    expect(writeProp([{ name: "external", value: null }], external, true)).toEqual([{ name: "external", value: null }])
    expect(writeProp([{ name: "external", value: "true", expression: true }], external, false)).toEqual([])
  })
})
