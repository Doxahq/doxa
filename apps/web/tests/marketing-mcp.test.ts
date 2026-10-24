import { describe, expect, it } from "vitest"
import { MCP_SERVER_URL } from "~/lib/marketing/links"
import {
  ALL_CLIENTS,
  ANY_CLIENT,
  MAIN_CLIENTS,
  MORE_CLIENTS,
  findClient,
  isMoreClient,
  menuCountLabel,
  menuGroups,
  moreButtonText,
  moreStack,
} from "~/lib/marketing/mcp"
import { commandSnippet, jsonSnippet, stepsSnippet, type SnippetLine } from "~/lib/marketing/mcp-snippet"

const text = (line: SnippetLine) => line.map((t) => t.text).join("")

describe("MCP client catalog", () => {
  it("has unique ids and a logo or a letter tile for every client", () => {
    const ids = ALL_CLIENTS.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const c of ALL_CLIENTS) {
      expect(Boolean(c.logo) !== Boolean(c.mono)).toBe(true)
      if (c.logo) expect(c.logo).toMatch(/^\/marketing\/logos\/[a-z]+\.svg$/)
    }
  })

  it("falls back to Claude Code for an unknown id", () => {
    expect(findClient("nope").id).toBe("claude-code")
    expect(findClient("zed").label).toBe("Zed")
  })

  it("puts menu clients and the server URL fallback behind More clients", () => {
    expect(MAIN_CLIENTS.map((c) => c.id)).toEqual(["claude-code", "claude", "cursor", "vscode", "codex"])
    expect(isMoreClient("cursor")).toBe(false)
    expect(isMoreClient("windsurf")).toBe(true)
    expect(isMoreClient(ANY_CLIENT.id)).toBe(true)
  })

  it("labels the More clients button for idle and picked states", () => {
    expect(moreButtonText(findClient("codex"))).toEqual({ label: "More clients", how: "17 more, or any MCP client" })
    expect(moreButtonText(findClient("warp"))).toEqual({ label: "Warp", how: "Terminal · Change client" })
    expect(moreStack()).toEqual({
      logos: ["/marketing/logos/chatgpt.svg", "/marketing/logos/windsurf.svg", "/marketing/logos/gemini.svg"],
      count: "+14",
    })
  })
})

describe("client menu search", () => {
  it("shows every group in order without a query", () => {
    const groups = menuGroups("")
    expect(groups.map((g) => g.name)).toEqual(["Chat apps", "Editors and IDEs", "CLI and terminal"])
    expect(groups.reduce((n, g) => n + g.clients.length, 0)).toBe(MORE_CLIENTS.length)
    expect(menuCountLabel("", MORE_CLIENTS.length)).toBe("17 clients")
  })

  it("matches name, kind and setup method, ignoring case and spaces, and drops empty groups", () => {
    const groups = menuGroups("  ONE COMMAND ")
    expect(groups.map((g) => g.key)).toEqual(["cli"])
    expect(groups[0].clients.map((c) => c.id)).toEqual(["gemini", "amp"])
    expect(menuCountLabel(" one command", 2)).toBe("2 of 17")
    expect(menuGroups("chat app").flatMap((g) => g.clients.map((c) => c.id))).toEqual([
      "chatgpt",
      "lechat",
      "cherry",
    ])
  })

  it("returns no groups when nothing matches", () => {
    expect(menuGroups("zzz")).toEqual([])
  })
})

describe("setup snippets", () => {
  it("colors JSON keys and string values and copies the pretty JSON", () => {
    const s = jsonSnippet({ mcpServers: { doxa: { url: MCP_SERVER_URL } } })
    expect(s.copy).toBe(JSON.stringify({ mcpServers: { doxa: { url: MCP_SERVER_URL } } }, null, 2))
    expect(s.lines.map(text)).toEqual(s.copy.split("\n"))
    expect(s.lines[0]).toEqual([{ text: "{" }])
    expect(s.lines[1]).toEqual([{ text: "  " }, { text: '"mcpServers"', tone: "t-k" }, { text: ": {" }])
    expect(s.lines[3]).toEqual([
      { text: "      " },
      { text: '"url"', tone: "t-k" },
      { text: ": " },
      { text: `"${MCP_SERVER_URL}"`, tone: "t-s" },
    ])
  })

  it("keeps the trailing comma after a string value", () => {
    const s = jsonSnippet({ servers: { doxa: { type: "http", url: "x" } } })
    expect(s.lines[3]).toEqual([
      { text: "      " },
      { text: '"type"', tone: "t-k" },
      { text: ": " },
      { text: '"http"', tone: "t-s" },
      { text: "," },
    ])
  })

  it("highlights the server URL in a command", () => {
    const s = commandSnippet(`claude mcp add --transport http doxa ${MCP_SERVER_URL}`, MCP_SERVER_URL)
    expect(s.copy).toBe(`claude mcp add --transport http doxa ${MCP_SERVER_URL}`)
    expect(s.lines).toEqual([
      [
        { text: "$ ", tone: "t-p" },
        { text: "claude mcp add --transport http doxa " },
        { text: MCP_SERVER_URL, tone: "t-k" },
      ],
    ])
  })

  it("numbers UI steps and copies the server URL", () => {
    const s = stepsSnippet([["Click Add"], ["Name  ", { value: "Doxa" }], ["URL   ", MCP_SERVER_URL]], MCP_SERVER_URL)
    expect(s.copy).toBe(MCP_SERVER_URL)
    expect(s.lines[1]).toEqual([{ text: "2  ", tone: "t-p" }, { text: "Name  " }, { text: "Doxa", tone: "t-s" }])
    expect(s.lines[2][2]).toEqual({ text: MCP_SERVER_URL, tone: "t-k" })
  })

  it("gives Claude Code a terminal command and Cursor a JSON config", () => {
    expect(findClient("claude-code").snippet.copy).toBe(`claude mcp add --transport http doxa ${MCP_SERVER_URL}`)
    expect(JSON.parse(findClient("cursor").snippet.copy)).toEqual({ mcpServers: { doxa: { url: MCP_SERVER_URL } } })
    expect(findClient("codex").snippet.copy).toBe(`[mcp_servers.doxa]\nurl = "${MCP_SERVER_URL}"`)
  })
})
