import { describe, expect, test } from "vitest"

import { formatOutline, parseOutline } from "~/lib/editor/file-tree-outline"
import type { FileTreeItem } from "~/lib/editor/mdx-document"

const tree: FileTreeItem[] = [
  {
    kind: "folder",
    attributes: [
      { name: "name", value: "src" },
      { name: "label", value: "Source" },
      { name: "defaultOpen", value: null },
    ],
    children: [
      { kind: "folder", attributes: [{ name: "name", value: "lib" }], children: [] },
      { kind: "file", attributes: [{ name: "name", value: "docs/overview/index.mdx" }] },
    ],
  },
  { kind: "file", attributes: [{ name: "name", value: "package.json" }] },
]

describe("file tree outline", () => {
  test("writes folders with a slash and two spaces per level", () => {
    expect(formatOutline(tree)).toBe("src/ # Source\n  lib/\n  docs/overview/index.mdx\npackage.json")
  })

  test("reads back the same tree", () => {
    expect(parseOutline(formatOutline(tree), tree)).toEqual({ ok: true, items: tree })
  })

  test("keeps the attributes of an item that keeps its path", () => {
    const result = parseOutline("src/ # Source\n  index.ts\nREADME.md", tree)
    expect(result).toEqual({
      ok: true,
      items: [
        { kind: "folder", attributes: tree[0].attributes, children: [{ kind: "file", attributes: [{ name: "name", value: "index.ts" }] }] },
        { kind: "file", attributes: [{ name: "name", value: "README.md" }] },
      ],
    })
  })

  test("reports an item nested under a file", () => {
    const result = parseOutline("package.json\n  index.ts")
    expect(result.ok).toBe(false)
  })

  test("accepts tabs and blank lines", () => {
    expect(parseOutline("src/\n\n\tindex.ts")).toEqual({
      ok: true,
      items: [{ kind: "folder", attributes: [{ name: "name", value: "src" }], children: [{ kind: "file", attributes: [{ name: "name", value: "index.ts" }] }] }],
    })
  })
})

describe("file tree labels", () => {
  test("a label after # is set, changed and removed", () => {
    expect(parseOutline("src/ # Code\n  index.ts # Entry", tree)).toEqual({
      ok: true,
      items: [
        {
          kind: "folder",
          attributes: [
            { name: "name", value: "src" },
            { name: "label", value: "Code" },
            { name: "defaultOpen", value: null },
          ],
          children: [
            {
              kind: "file",
              attributes: [
                { name: "name", value: "index.ts" },
                { name: "label", value: "Entry" },
              ],
            },
          ],
        },
      ],
    })
    const unlabelled = parseOutline("src/", tree)
    expect(unlabelled.ok && unlabelled.items[0].attributes).toEqual([
      { name: "name", value: "src" },
      { name: "defaultOpen", value: null },
    ])
  })

  test("a # inside a name without spaces around it stays part of the name", () => {
    expect(parseOutline("C#/\n  Program.cs")).toEqual({
      ok: true,
      items: [{ kind: "folder", attributes: [{ name: "name", value: "C#" }], children: [{ kind: "file", attributes: [{ name: "name", value: "Program.cs" }] }] }],
    })
  })
})
