// @vitest-environment jsdom
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { Editor } from "@tiptap/core"
import { parseRuntimeMdx } from "@doxahq/mdx-runtime"
import { afterEach, describe, expect, test } from "vitest"

import {
  captureOriginalBlocks,
  parseMdxDocument,
  serializeMdxDocument,
  setFrontmatterField,
  type MdxCard,
} from "~/lib/editor/mdx-document"
import { createWriteExtensions } from "~/lib/editor/write-extensions"

// Real generated pages. They are read here and never written.
const SETS_DIRECTORY = join(import.meta.dirname, "../../../packages/docs-artifact-fixtures/sets")

function listMdxFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) return listMdxFiles(path)
    return name.endsWith(".mdx") ? [path] : []
  })
}

const fixturePages = listMdxFiles(SETS_DIRECTORY).map((path) => ({
  name: relative(SETS_DIRECTORY, path),
  source: readFileSync(path, "utf8"),
}))

const editors: Editor[] = []
afterEach(() => {
  while (editors.length > 0) editors.pop()?.destroy()
})

/** Loads a page the way the Write editor does. */
function load(source: string) {
  const document = parseMdxDocument(source)
  const editor = new Editor({ extensions: createWriteExtensions(), content: document.content })
  editors.push(editor)
  const originals = captureOriginalBlocks(editor.getJSON())
  const save = (meta = { title: document.title, description: document.description }) =>
    serializeMdxDocument(document, editor.getJSON(), originals, meta)
  return { document, editor, save }
}

describe("Write editor MDX round trip", () => {
  test("finds the fixture pages", () => {
    expect(fixturePages.length).toBeGreaterThan(10)
  })

  test.each(fixturePages)("$name saves back byte for byte without edits", ({ source }) => {
    expect(load(source).save()).toBe(source)
  })

  test.each(fixturePages)("$name renders the same after an edit elsewhere", ({ source }) => {
    const { editor, save } = load(source)
    // Add a new top-level paragraph after the last block.
    editor.commands.insertContentAt(editor.state.doc.content.size, {
      type: "paragraph",
      content: [{ type: "text", text: "Added line." }],
    })
    const saved = save()
    expect(saved.startsWith(source.trimEnd())).toBe(true)
    expect(saved).toContain("Added line.")
    const before = parseRuntimeMdx(source).nodes
    const after = parseRuntimeMdx(saved).nodes
    expect(after.slice(0, before.length)).toEqual(before)
  })
})

describe("Write editor edits", () => {
  const source = [
    "---",
    "title: Guide",
    "description: 'How it works'",
    "---",
    "",
    "## Setup",
    "",
    "First paragraph with *old* style.",
    "",
    "* one",
    "* two",
    "",
    "<Mermaid",
    "  chart={`graph TD;",
    "    A --> B;`}",
    "/>",
    "",
  ].join("\n")

  test("an edited block is written in the shared style and the others keep their text", () => {
    const { editor, save } = load(source)
    // Put the cursor in the first paragraph and type.
    let paragraphEnd = 0
    editor.state.doc.forEach((node, offset) => {
      if (node.type.name === "paragraph" && paragraphEnd === 0) paragraphEnd = offset + node.nodeSize - 1
    })
    editor.chain().setTextSelection(paragraphEnd).insertContent(" More").run()

    expect(save()).toBe(
      [
        "---",
        "title: Guide",
        "description: 'How it works'",
        "---",
        "",
        "## Setup",
        "",
        "First paragraph with _old_ style. More",
        "",
        "* one",
        "* two",
        "",
        "<Mermaid",
        "  chart={`graph TD;",
        "    A --> B;`}",
        "/>",
        "",
      ].join("\n"),
    )
  })

  test("a diagram with a template-literal chart loads as a diagram block", () => {
    const { editor } = load(source)
    const types: string[] = []
    editor.state.doc.forEach((node) => types.push(node.type.name))
    expect(types).toEqual(["heading", "paragraph", "bulletList", "mermaid"])
  })

  test("a component with JavaScript loads as a locked block", () => {
    const { editor } = load("<Mermaid chart={`graph ${direction};`} />\n")
    expect(editor.state.doc.firstChild?.type.name).toBe("mdxBlock")
  })

  test("title and description edits change only their frontmatter lines", () => {
    const { save } = load(source)
    const saved = save({ title: "Guide: basics", description: "It's simple" })
    expect(saved.split("\n").slice(0, 4)).toEqual([
      "---",
      'title: "Guide: basics"',
      "description: 'It''s simple'",
      "---",
    ])
    expect(saved.split("\n").slice(4).join("\n")).toBe(source.split("\n").slice(4).join("\n"))
  })
})

describe("setFrontmatterField", () => {
  test("adds a missing key before the closing line", () => {
    expect(setFrontmatterField("---\ntitle: A\n---\n", "description", "B")).toBe("---\ntitle: A\ndescription: B\n---\n")
  })

  test("creates frontmatter when there is none", () => {
    expect(setFrontmatterField("", "title", "A")).toBe("---\ntitle: A\n---\n")
  })
})

describe("card groups", () => {
  const source = [
    "<CardGrid>",
    '  <Card title="One" icon="layers">First body.</Card>',
    '  <Card title="Two">',
    "    Second body.",
    "  </Card>",
    "</CardGrid>",
    "",
  ].join("\n")

  test("both card body forms load as an editable card group and save back unchanged", () => {
    const { editor, save } = load(source)
    expect(editor.state.doc.firstChild?.type.name).toBe("cardGroup")
    expect(save()).toBe(source)
  })

  test("an edited card group keeps each card's body form", () => {
    const { editor, save } = load(source)
    const cards = editor.state.doc.firstChild?.attrs.cards as Array<{ attributes: Array<{ name: string; value: string }> }>
    editor.commands.command(({ tr }) => {
      tr.setNodeAttribute(0, "cards", [
        { ...cards[0], attributes: [{ name: "title", value: "Uno" }, cards[0].attributes[1]] },
        cards[1],
      ])
      return true
    })
    expect(save()).toBe(
      [
        "<CardGrid>",
        '  <Card title="Uno" icon="layers">First body.</Card>',
        "",
        '  <Card title="Two">',
        "    Second body.",
        "  </Card>",
        "</CardGrid>",
        "",
      ].join("\n"),
    )
  })
})

describe("one-line cards on neighbouring lines", () => {
  const source = [
    "<CardGrid>",
    '  <Card title="One" icon="layers">First body.</Card>',
    '  <Card title="Two" icon="zap">Second body.</Card>',
    "</CardGrid>",
    "",
  ].join("\n")

  test("load as one editable card group", () => {
    const { editor, save } = load(source)
    expect(editor.state.doc.firstChild?.type.name).toBe("cardGroup")
    expect((editor.state.doc.firstChild?.attrs.cards as unknown[]).length).toBe(2)
    expect(save()).toBe(source)
  })

  test("stay on neighbouring lines after an edit", () => {
    const { editor, save } = load(source)
    const cards = editor.state.doc.firstChild?.attrs.cards as Array<{ body: string }>
    editor.commands.command(({ tr }) => {
      tr.setNodeAttribute(0, "cards", [cards[0], { ...cards[1], body: "Changed." }])
      return true
    })
    const saved = save()
    expect(saved).toContain('<Card title="Two" icon="zap">Changed.</Card>')
    expect(parseRuntimeMdx(saved).nodes).toHaveLength(1)
  })
})

describe("typed markup and code stay text", () => {
  test("a heading or paragraph with <script> or {…} saves escaped and renders as text", () => {
    const { editor, save } = load("## Setup\n")
    editor.commands.insertContentAt(editor.state.doc.content.size, [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: 'New <script>alert("me")</script>' }] },
      { type: "paragraph", content: [{ type: "text", text: "Run {alert(document.cookie)} and <img src=x onerror=alert(1)>" }] },
    ])
    const saved = save()

    // MDX would read an unescaped `<` or `{` as JSX or JavaScript.
    expect(saved).toContain('## New \\<script>alert("me")\\</script>')
    expect(saved).toContain("Run \\{alert(document.cookie)} and \\<img src=x onerror=alert(1)>")

    const rendered = JSON.stringify(parseRuntimeMdx(saved).nodes)
    expect(rendered).not.toContain('"name":"script"')
    expect(rendered).not.toContain('"name":"img"')
    expect(rendered).toContain('New <script>alert(\\"me\\")</script>')
    expect(rendered).toContain("Run {alert(document.cookie)} and <img src=x onerror=alert(1)>")
  })
})

describe("cards without a grid", () => {
  const source = [
    "## Key features",
    "",
    '<Card title="Self-hosted control plane">',
    "  Run the FlagForge API in your own environment.",
    "</Card>",
    "",
    '<Card title="Typed variations">',
    "  Serve boolean, string, number, or JSON values.",
    "</Card>",
    "",
  ].join("\n")

  test("load as editable cards and save back unchanged", () => {
    const { editor, save } = load(source)
    const types: string[] = []
    editor.state.doc.forEach((node) => types.push(`${node.type.name}:${node.attrs.grid ?? ""}`))
    expect(types).toEqual(["heading:", "cardGroup:false", "cardGroup:false"])
    expect(save()).toBe(source)
  })

  test("an edited card is written without a grid, as the site draws it", () => {
    const { editor, save } = load(source)
    const cards = editor.state.doc.child(1).attrs.cards as MdxCard[]
    editor.commands.command(({ tr }) => {
      tr.setNodeAttribute(positionOf(editor, "cardGroup"), "cards", [{ ...cards[0], body: "Run it anywhere." }])
      return true
    })
    const saved = save()
    expect(saved).not.toContain("CardGrid")
    expect(saved).toContain('<Card title="Self-hosted control plane">\n  Run it anywhere.\n</Card>')
    expect(parseRuntimeMdx(saved).nodes.map((node) => (node.type === "element" ? node.name : node.type))).toEqual(["h2", "Card", "Card"])
  })

  test("one-line cards on neighbouring lines load as one block and stay one line", () => {
    const oneLine = ['<Card title="One">First.</Card>', '<Card title="Two">Second.</Card>', ""].join("\n")
    const { editor, save } = load(oneLine)
    expect(editor.state.doc.childCount).toBe(1)
    expect(save()).toBe(oneLine)
  })
})

describe("card text with Markdown", () => {
  const source = [
    "<CardGrid>",
    '  <Card title="SDK">',
    "    Evaluate flags with `client.isEnabled()` and **no** network calls. See the [guide](/guide).",
    "  </Card>",
    "</CardGrid>",
    "",
  ].join("\n")

  test("loads as an editable card group and saves back unchanged", () => {
    const { editor, save } = load(source)
    expect(editor.state.doc.firstChild?.type.name).toBe("cardGroup")
    const [card] = editor.state.doc.firstChild?.attrs.cards as MdxCard[]
    expect(card).toMatchObject({ markdown: true, body: "Evaluate flags with `client.isEnabled()` and **no** network calls. See the [guide](/guide)." })
    expect(save()).toBe(source)
  })

  test("keeps its Markdown after an edit", () => {
    const { editor, save } = load(source)
    const [card] = editor.state.doc.firstChild?.attrs.cards as MdxCard[]
    editor.commands.command(({ tr }) => {
      tr.setNodeAttribute(0, "cards", [{ ...card, attributes: [{ name: "title", value: "TypeScript SDK" }] }])
      return true
    })
    const saved = save()
    expect(saved).toContain('title="TypeScript SDK"')
    const before = findElement(parseRuntimeMdx(source).nodes, "Card")
    const after = findElement(parseRuntimeMdx(saved).nodes, "Card")
    expect(after?.children).toEqual(before?.children)
  })
})

describe("literal attribute values", () => {
  const source = [
    "<CardGrid>",
    "  <Card",
    '    title="Repository"',
    '    href="https://github.com/doxahq/doxa"',
    "    external={true}",
    "  />",
    "</CardGrid>",
    "",
  ].join("\n")

  test("a card with external={true} loads as an editable card group", () => {
    const { editor, save } = load(source)
    expect(editor.state.doc.firstChild?.type.name).toBe("cardGroup")
    expect(save()).toBe(source)
  })

  test("an edited card keeps its literal value", () => {
    const { editor, save } = load(source)
    const cards = editor.state.doc.firstChild?.attrs.cards as Array<{ attributes: Array<{ name: string }> }>
    editor.commands.command(({ tr }) => {
      tr.setNodeAttribute(0, "cards", [
        { ...cards[0], attributes: cards[0].attributes.map((a) => (a.name === "title" ? { ...a, value: "Repo" } : a)) },
      ])
      return true
    })
    const saved = save()
    expect(saved).toContain("external={true}")
    expect(saved).toContain('title="Repo"')
    expect(parseRuntimeMdx(saved).nodes).toEqual(parseRuntimeMdx(source.replace('"Repository"', '"Repo"')).nodes)
  })

  test("an attribute with code stays locked", () => {
    const { editor } = load('<Note title={site.name}>\n\nText.\n\n</Note>\n')
    expect(editor.state.doc.firstChild?.type.name).toBe("mdxBlock")
  })
})

describe("tables", () => {
  const source = [
    "| Option | Default |",
    "| :----- | ------: |",
    "| `port` |    3000 |",
    "| open   | **no**  |",
    "",
  ].join("\n")

  test("load as an editable table and save back unchanged", () => {
    const { editor, save } = load(source)
    expect(editor.state.doc.firstChild?.type.name).toBe("table")
    expect(save()).toBe(source)
  })

  test("an added row keeps the header and the alignment", () => {
    const { editor, save } = load(source)
    editor.chain().setTextSelection(3).addRowAfter().run()
    const saved = save()
    expect(saved.split("\n")[1]).toMatch(/^\| :-+ \| -+: \|$/)
    const table = parseRuntimeMdx(saved).nodes[0]
    expect(table.type === "element" && table.children?.[1].type === "element" && table.children[1].children?.length).toBe(3)
  })

  test("a line break in a cell becomes a space, so the table stays one line per row", () => {
    const { editor, save } = load(source)
    // Position 10 is the end of "Option" in the first header cell.
    editor.chain().setTextSelection(10).setHardBreak().insertContent("more").run()
    const saved = save()
    expect(saved.split("\n")).toHaveLength(5)
    expect(saved).toContain("Option more")
  })
})

describe("pasted tables", () => {
  test("drop the column widths a web page or a document brings", () => {
    const { editor, save } = load("Intro.\n")
    editor.commands.insertContentAt(editor.state.doc.content.size, [
      '<table><tbody><tr><th colwidth="420">Name</th><th colwidth="380">Type</th></tr>',
      '<tr><td colwidth="420">alpha</td><td colwidth="380">string</td></tr></tbody></table>',
    ].join(""))
    const widths: unknown[] = []
    editor.state.doc.descendants((node) => {
      if (node.type.name === "tableCell" || node.type.name === "tableHeader") widths.push(node.attrs.colwidth)
    })
    expect(widths).toEqual([null, null, null, null])
    expect(save()).toContain("| Name  | Type   |")
  })
})

describe("block quotes", () => {
  test("load as an editable quote and save back unchanged", () => {
    const source = "> A block quote survives the round trip.\n"
    const { editor, save } = load(source)
    expect(editor.state.doc.firstChild?.type.name).toBe("blockquote")
    expect(save()).toBe(source)
  })
})

/** The runtime props of the first element named `name`, searched depth first. */
function findElement(nodes: readonly unknown[], name: string): { props?: Record<string, unknown>; children?: unknown[] } | null {
  for (const node of nodes as Array<{ type: string; name?: string; children?: unknown[] }>) {
    if (node.type === "element" && node.name === name) return node
    const inner = node.children ? findElement(node.children, name) : null
    if (inner) return inner
  }
  return null
}

/** Position of the first node of a type, for commands. */
function positionOf(editor: Editor, type: string, nth = 0): number {
  let found = -1
  let seen = 0
  editor.state.doc.descendants((node, pos) => {
    if (found !== -1) return false
    if (node.type.name === type) {
      if (seen === nth) found = pos
      seen += 1
    }
    return true
  })
  return found
}

describe("steps", () => {
  const source = [
    "<Step>",
    '  <StepItem title="Install dependencies">',
    "",
    "```bash",
    "pnpm install",
    "```",
    "",
    "  </StepItem>",
    "",
    '  <StepItem title="Open the site">',
    "    Open the browser.",
    "  </StepItem>",
    "</Step>",
    "",
  ].join("\n")

  test("load as editable steps and save back unchanged", () => {
    const { editor, save } = load(source)
    expect(editor.state.doc.firstChild?.type.name).toBe("steps")
    expect(editor.state.doc.firstChild?.childCount).toBe(2)
    expect(save()).toBe(source)
  })

  test("a title typed in place becomes the title attribute", () => {
    const { editor, save } = load(source)
    const title = positionOf(editor, "stepTitle", 1)
    editor.chain().setTextSelection(title + 1 + "Open the site".length).insertContent(" locally").run()
    const saved = save()
    expect(saved).toContain('<StepItem title="Open the site locally">')
    const steps = findElement(parseRuntimeMdx(saved).nodes, "Step")
    expect(steps?.children?.filter((child) => (child as { type: string }).type === "element")).toHaveLength(2)
  })

  test("one-line steps stay one line after an edit", () => {
    const oneLine = [
      "<Step>",
      '<StepItem title="Install">Add the package.</StepItem>',
      '<StepItem title="Run">Run the client.</StepItem>',
      "</Step>",
      "",
    ].join("\n")
    const { editor, save } = load(oneLine)
    const title = positionOf(editor, "stepTitle", 0)
    editor.chain().setTextSelection(title + 1).insertContent("Now ").run()
    const saved = save()
    expect(saved).toContain('<StepItem title="Now Install">Add the package.</StepItem>')
    expect(saved).toContain('<StepItem title="Run">Run the client.</StepItem>')
  })
})

describe("tabs", () => {
  const source = [
    '<Tabs defaultValue="cloudflare" className="pt-5 pb-1">',
    "  <TabsList>",
    '    <TabsTrigger value="cloudflare">Cloudflare</TabsTrigger>',
    '    <TabsTrigger value="vercel">Vercel</TabsTrigger>',
    "  </TabsList>",
    '  <TabsContent value="cloudflare">',
    "",
    "```bash",
    "pnpm build:cloudflare",
    "```",
    "",
    "  </TabsContent>",
    '  <TabsContent value="vercel">',
    "",
    "```bash",
    "pnpm build:vercel",
    "```",
    "",
    "  </TabsContent>",
    "</Tabs>",
    "",
  ].join("\n")

  test("load as editable tabs and save back unchanged", () => {
    const { editor, save } = load(source)
    const tabs = editor.state.doc.firstChild
    expect(tabs?.type.name).toBe("tabs")
    expect(tabs?.childCount).toBe(2)
    expect(tabs?.child(1).attrs).toMatchObject({ label: "Vercel", value: "vercel" })
    expect(save()).toBe(source)
  })

  test("a renamed tab keeps its value", () => {
    const { editor, save } = load(source)
    editor.commands.command(({ tr }) => {
      tr.setNodeAttribute(positionOf(editor, "tabItem", 1), "label", "Vercel Edge")
      return true
    })
    const saved = save()
    expect(saved).toContain('<TabsTrigger value="vercel">Vercel Edge</TabsTrigger>')
    expect(saved).toContain('<TabsContent value="vercel">')
  })

  test("a new tab gets a value from its label, and defaultValue follows a removed tab", () => {
    const { editor, save } = load(source)
    const first = positionOf(editor, "tabItem", 0)
    editor.commands.command(({ tr, state }) => {
      tr.delete(first, first + state.doc.nodeAt(first)!.nodeSize)
      return true
    })
    editor.commands.insertContentAt(positionOf(editor, "tabItem", 0), {
      type: "tabItem",
      attrs: { label: "Deno Deploy" },
      content: [{ type: "paragraph", content: [{ type: "text", text: "Soon." }] }],
    })
    const saved = save()
    expect(saved).toContain('<Tabs defaultValue="deno-deploy" className="pt-5 pb-1">')
    expect(saved).toContain('<TabsTrigger value="deno-deploy">Deno Deploy</TabsTrigger>')
    const tabs = findElement(parseRuntimeMdx(saved).nodes, "Tabs")
    expect(tabs?.props?.defaultValue).toBe("deno-deploy")
  })
})

describe("one-line tab panels", () => {
  const source = [
    '<Tabs defaultValue="npm">',
    "  <TabsList>",
    '    <TabsTrigger value="npm">npm</TabsTrigger>',
    '    <TabsTrigger value="pnpm">pnpm</TabsTrigger>',
    "  </TabsList>",
    '  <TabsContent value="npm">```bash npm install @auth/prisma-adapter ```</TabsContent>',
    '  <TabsContent value="pnpm">```bash pnpm add @auth/prisma-adapter ```</TabsContent>',
    "</Tabs>",
    "",
  ].join("\n")

  test("stay one line and render the same after an edit", () => {
    const { editor, save } = load(source)
    editor.commands.command(({ tr }) => {
      tr.setNodeAttribute(positionOf(editor, "tabItem", 1), "label", "PNPM")
      return true
    })
    const saved = save()
    expect(saved).toContain('<TabsContent value="npm">`bash npm install @auth/prisma-adapter `</TabsContent>')
    const panels = (tabs: ReturnType<typeof findElement>) => tabs?.children?.filter((child) => (child as { name?: string }).name === "TabsContent")
    expect(panels(findElement(parseRuntimeMdx(saved).nodes, "Tabs"))).toEqual(panels(findElement(parseRuntimeMdx(source).nodes, "Tabs")))
  })
})

describe("file trees and diagrams", () => {
  const source = [
    "<Mermaid",
    "  chart={`graph TD;",
    "    Visitor[Visitor] --> Dispatcher[doxa-docs-renderer];",
    "    Dispatcher --> Worker[Dynamic Worker];`}",
    "/>",
    "",
    "<FileTree>",
    '  <Folder name="src" label="Source" defaultOpen>',
    '    <File name="router.tsx" />',
    "  </Folder>",
    "</FileTree>",
    "",
  ].join("\n")

  test("load as a diagram and a file tree and save back unchanged", () => {
    const { editor, save } = load(source)
    expect(editor.state.doc.child(0).type.name).toBe("mermaid")
    expect(editor.state.doc.child(0).attrs.chart).toBe(
      "graph TD;\n  Visitor[Visitor] --> Dispatcher[doxa-docs-renderer];\n  Dispatcher --> Worker[Dynamic Worker];",
    )
    expect(editor.state.doc.child(1).type.name).toBe("fileTree")
    expect(save()).toBe(source)
  })

  test.each([
    "graph LR;\n  A --> B;",
    "sequenceDiagram\n    Alice->>Bob: `hello` ${name}\n\n    Bob-->>Alice: C:\\\\path",
    "mindmap\n  root\n    child\n      grandchild",
  ])("an edited chart reads back exactly: %s", (chart) => {
    const { editor, save } = load(source)
    editor.commands.command(({ tr }) => {
      tr.setNodeAttribute(0, "chart", chart)
      return true
    })
    expect(findElement(parseRuntimeMdx(save()).nodes, "Mermaid")?.props?.chart).toBe(chart)
  })

  test("a chart inside a tab reads back exactly", () => {
    const chart = "flowchart TD\n  A --> B\n    B --> C"
    const { editor, save } = load("<Tabs defaultValue=\"a\">\n  <TabsList>\n    <TabsTrigger value=\"a\">A</TabsTrigger>\n  </TabsList>\n  <TabsContent value=\"a\">\n    Text.\n  </TabsContent>\n</Tabs>\n")
    editor.commands.insertContentAt(positionOf(editor, "tabItem") + 1, { type: "mermaid", attrs: { chart } })
    expect(findElement(parseRuntimeMdx(save()).nodes, "Mermaid")?.props?.chart).toBe(chart)
  })

  test("an edited file tree writes folders and files", () => {
    const { editor, save } = load(source)
    editor.commands.command(({ tr }) => {
      tr.setNodeAttribute(positionOf(editor, "fileTree"), "items", [
        {
          kind: "folder",
          attributes: [{ name: "name", value: "src" }, { name: "defaultOpen", value: null }],
          children: [{ kind: "file", attributes: [{ name: "name", value: "index.ts" }] }],
        },
        { kind: "file", attributes: [{ name: "name", value: "package.json" }] },
      ])
      return true
    })
    const saved = save()
    expect(saved).toContain(
      ['<FileTree>', '  <Folder name="src" defaultOpen>', '    <File name="index.ts" />', "  </Folder>", "", '  <File name="package.json" />', "</FileTree>"].join("\n"),
    )
  })
})

describe("empty-line hint", () => {
  function hints(editor: Editor): string[] {
    return [...editor.view.dom.querySelectorAll(".is-empty")].map((element) => element.getAttribute("data-placeholder") ?? "")
  }

  test("shows only on the empty line with the cursor as the cursor moves", () => {
    const { editor } = load("Intro.\n")
    editor.commands.insertContentAt(editor.state.doc.content.size, [{ type: "paragraph" }, { type: "paragraph" }, { type: "paragraph" }])
    const starts: number[] = []
    editor.state.doc.forEach((node, offset) => {
      if (node.type.name === "paragraph" && node.content.size === 0) starts.push(offset + 1)
    })
    expect(starts).toHaveLength(3)
    for (const start of [...starts, ...starts.slice().reverse()]) {
      editor.commands.setTextSelection(start)
      expect(hints(editor)).toEqual(["Type '/' for commands, or just start writing"])
    }
    editor.commands.setTextSelection(3)
    expect(hints(editor)).toEqual([])
  })

  test("shows in a step's empty title and skips table cells", () => {
    const { editor } = load('<Step>\n  <StepItem>\n    Body.\n  </StepItem>\n</Step>\n\n| A |\n| - |\n|   |\n')
    editor.commands.setTextSelection(3)
    expect(hints(editor)).toEqual(["Step title"])
    let cell = -1
    editor.state.doc.descendants((node, pos) => {
      if (cell === -1 && node.type.name === "tableCell") cell = pos
    })
    editor.commands.setTextSelection(cell + 2)
    expect(hints(editor)).toEqual([])
  })
})

describe("save correctness", () => {
  /**
   * Writes every block from the editor model, as if each one was edited, and
   * checks that the page renders the same. This proves the editor models each
   * block completely: an edit anywhere in a block cannot lose what it holds.
   */
  test.each(fixturePages)("$name renders the same when every block is written from the editor", ({ source }) => {
    const { document, editor } = load(source)
    const rewritten = serializeMdxDocument(document, editor.getJSON(), new Map(), {
      title: document.title,
      description: document.description,
    })
    expect(parseRuntimeMdx(rewritten).nodes).toEqual(parseRuntimeMdx(source).nodes)

    // A second load and write changes nothing more.
    const again = load(rewritten)
    expect(serializeMdxDocument(again.document, again.editor.getJSON(), new Map(), { title: again.document.title, description: again.document.description })).toBe(rewritten)
  })
})
