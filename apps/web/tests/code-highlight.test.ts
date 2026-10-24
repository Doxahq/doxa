// @vitest-environment jsdom
import { Editor } from "@tiptap/core"
import { getDocsHighlighter } from "@doxahq/mdx-runtime/highlight"
import { getLazyDocsHighlighter } from "@doxahq/mdx-runtime/highlight-lazy"
import { afterEach, describe, expect, test, vi } from "vitest"

import { CodeHighlight, collectCodeBlockLanguages } from "~/lib/editor/code-highlight"
import { parseMdxDocument } from "~/lib/editor/mdx-document"
import { createWriteExtensions } from "~/lib/editor/write-extensions"

let editor: Editor | null = null
afterEach(() => {
  editor?.destroy()
  editor = null
  vi.restoreAllMocks()
})

function open(source: string) {
  editor = new Editor({ extensions: createWriteExtensions({}, [CodeHighlight]), content: parseMdxDocument(source).content })
  return editor
}

async function tokens(current: Editor): Promise<HTMLElement[]> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const found = [...current.view.dom.querySelectorAll<HTMLElement>(".doxa-code-token")]
    if (found.length > 0) return found
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return []
}

describe("code highlighting", () => {
  test("colors a known language with both theme colors", async () => {
    const current = open("```ts\nconst ready: boolean = true\n```\n")
    const spans = await tokens(current)
    expect(spans.length).toBeGreaterThan(2)
    expect(spans[0].getAttribute("style")).toMatch(/--shiki-light:\s*#[0-9a-f]+;\s*--shiki-dark:\s*#[0-9a-f]+/i)
    // Decorations color the text. They never change it.
    expect(current.state.doc.textContent).toBe("const ready: boolean = true")
  })

  test("follows edits and leaves an unknown language plain", async () => {
    const current = open("```ts\nconst a = 1\n```\n\n```not-a-language\nplain text\n```\n")
    await tokens(current)
    current.commands.insertContentAt(2, "let ")
    const blocks = [...current.view.dom.querySelectorAll("pre")]
    expect(blocks[0].querySelectorAll(".doxa-code-token").length).toBeGreaterThan(0)
    expect(blocks[1].querySelectorAll(".doxa-code-token")).toHaveLength(0)
  })
})

describe("the page's code languages", () => {
  test("lists each known language once, by grammar name, in page order", () => {
    const { content } = parseMdxDocument(
      [
        "```sh",
        "npm i doxa",
        "```",
        "",
        '<Note title="Tip">',
        "",
        "```ts",
        "const a = 1",
        "```",
        "",
        "</Note>",
        "",
        "```bash",
        "echo again",
        "```",
        "",
        "```not-a-language",
        "x",
        "```",
        "",
        "```",
        "no language",
        "```",
        "",
        "```jsonc",
        "{}",
        "```",
        "",
      ].join("\n"),
    )
    const current = new Editor({ extensions: createWriteExtensions({}, []), content })
    editor = current
    expect(collectCodeBlockLanguages(current.state.doc)).toEqual(["bash", "typescript", "json"])
  })
})

describe("loading grammars per page", () => {
  test("loads only the grammars of the page's code blocks", async () => {
    const lazy = await getLazyDocsHighlighter()
    const load = vi.spyOn(lazy, "load")
    const current = open("```py\nprint(1)\n```\n\n```toml\na = 1\n```\n\nSome text.\n")
    await tokens(current)
    const requested = load.mock.calls.flatMap(([languages]) => [...languages])
    expect(new Set(requested)).toEqual(new Set(["python", "toml"]))
  })

  test("draws the same colors as the published site's highlighter", async () => {
    const code = "export const ready: boolean = await check(`ok`) // done"
    const current = open(`\`\`\`ts\n${code}\n\`\`\`\n`)
    const spans = await tokens(current)
    const expected = getDocsHighlighter()
      .codeToTokens(code, { lang: "typescript", themes: { light: "github-light", dark: "github-dark" }, defaultColor: false })
      .tokens.flat()
      .filter((token) => token.content.length > 0)
      .map((token) => ({ text: token.content, light: token.htmlStyle?.["--shiki-light"], dark: token.htmlStyle?.["--shiki-dark"] }))
    const drawn = spans.map((span) => ({
      text: span.textContent,
      light: span.style.getPropertyValue("--shiki-light"),
      dark: span.style.getPropertyValue("--shiki-dark"),
    }))
    expect(drawn).toEqual(expected)
  })

  test("computes tokens after an edit, not inside it, and keeps the old colors meanwhile", async () => {
    const current = open("```ts\nconst first = 1\n```\n")
    await tokens(current)
    const lazy = await getLazyDocsHighlighter()
    const tokenize = vi.spyOn(lazy.shiki, "codeToTokens")

    current.commands.insertContentAt(current.state.doc.child(0).nodeSize - 1, "\nconst second = 2")

    // The edit itself does no tokenizing. The block keeps its colors.
    expect(tokenize).not.toHaveBeenCalled()
    expect(current.view.dom.querySelectorAll(".doxa-code-token").length).toBeGreaterThan(0)

    // Idle time then colors the new line.
    for (let attempt = 0; attempt < 50 && tokenize.mock.calls.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(tokenize).toHaveBeenCalledTimes(1)
    const colored = [...current.view.dom.querySelectorAll(".doxa-code-token")].map((span) => span.textContent)
    expect(colored).toContain("second")
  })
})
