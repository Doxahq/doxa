import { CompletionContext } from "@codemirror/autocomplete"
import { json } from "@codemirror/lang-json"
import { EditorState } from "@codemirror/state"
import { siteConfigJsonSchema } from "@doxahq/site-config"
import { describe, expect, test } from "vitest"

import {
  completeFromSchema,
  locateJsonPointer,
  toJsonSchemaNode,
} from "~/components/code-editor/languages/json"

const text = `{
  "name": "Acme",
  "navbar": {
    "links": [
      { "label": "Blog", "href": "/blog" },
      { "label": "Docs", "href": "/docs" }
    ]
  },
  "a/b": 1
}`

function stateFor(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [json()] })
}

function slice(doc: string, range: { from: number; to: number } | null): string | null {
  return range ? doc.slice(range.from, range.to) : null
}

describe("locateJsonPointer", () => {
  const state = stateFor(text)

  test.each([
    ["/name", "value", '"Acme"'],
    ["/name", "key", '"name"'],
    ["/navbar/links/1/href", "value", '"/docs"'],
    ["/navbar/links/0", "value", '{ "label": "Blog", "href": "/blog" }'],
    ["/a~1b", "key", '"a/b"'],
  ] as const)("%s (%s)", (pointer, target, expected) => {
    expect(slice(text, locateJsonPointer(state, pointer, target))).toBe(expected)
  })

  test("a missing key resolves to the object that must hold it", () => {
    const range = locateJsonPointer(state, "/navbar/cta/href")
    expect(slice(text, range)?.startsWith('{\n    "links"')).toBe(true)
  })

  test("the root pointer is the whole document", () => {
    expect(slice(text, locateJsonPointer(state, ""))).toBe(text)
  })
})

describe("schema completion", () => {
  const schema = toJsonSchemaNode(siteConfigJsonSchema())

  function labelsAt(doc: string, marker = "|"): string[] {
    const position = doc.indexOf(marker)
    const state = stateFor(doc.replace(marker, ""))
    const result = completeFromSchema(new CompletionContext(state, position, true), schema)
    return result?.options.map((option) => option.label) ?? []
  }

  test("reads the generated schema", () => {
    expect(schema.properties?.navbar?.properties?.links?.maxItems).toBe(8)
  })

  test("suggests the keys of the object at the cursor", () => {
    const labels = labelsAt('{"navbar": {|}}')
    expect(labels).toEqual(expect.arrayContaining(['"cta"', '"links"', '"github"']))
    expect(labels).not.toContain('"name"')
  })

  test("leaves out keys that are already present", () => {
    expect(labelsAt('{"navbar": {"github": null, |}}')).not.toContain('"github"')
  })

  test("suggests enum values for a value position", () => {
    expect(labelsAt('{"theme": {"preset": |}}')).toEqual(['"default"', '"brutalist"'])
  })

  test("suggests true and false for a boolean", () => {
    expect(labelsAt('{"branding": {"poweredBy": |}}')).toEqual(["true", "false"])
  })
})
