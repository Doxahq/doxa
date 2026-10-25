// Setup snippets for the MCP page, as lines of colored tokens. The page
// renders each token as a <span>; nothing here builds HTML.

/** A token class from mcp.css: prompt, key, string or comment. */
export type SnippetTone = "t-p" | "t-k" | "t-s" | "t-c"

export interface SnippetToken {
  text: string
  tone?: SnippetTone
}

export type SnippetLine = SnippetToken[]

export interface Snippet {
  /** The text the copy button puts on the clipboard. */
  copy: string
  lines: SnippetLine[]
}

/** One step value: plain text, a highlighted string (`{ value }`), or the server URL. */
export type StepPart = string | { value: string }

/** One token; no tone means plain text. */
export function token(text: string, tone?: SnippetTone): SnippetToken {
  return tone ? { text, tone } : { text }
}

/** Builds a line and drops empty tokens, which render nothing. */
export function line(...tokens: SnippetToken[]): SnippetLine {
  return tokens.filter((t) => t.text !== "")
}

/** Pretty-prints a JSON config and colors its keys and string values. */
export function jsonSnippet(value: unknown): Snippet {
  const text = JSON.stringify(value, null, 2)
  const lines = text.split("\n").map((row) => {
    const m = row.match(/^(\s*)("[^"]*")(: )(.*)$/)
    if (!m) return line(token(row))
    const [, indent, key, colon, rest] = m
    const v = rest.match(/^("[^"]*")(,?)$/)
    return v
      ? line(token(indent), token(key, "t-k"), token(colon), token(v[1], "t-s"), token(v[2]))
      : line(token(indent), token(key, "t-k"), token(colon + rest))
  })
  return { copy: text, lines }
}

/** A one-line shell command; the server URL in it is highlighted. */
export function commandSnippet(command: string, url: string): Snippet {
  const has = command.includes(url)
  return {
    copy: command,
    lines: [line(token("$ ", "t-p"), token(command.replace(url, "")), token(has ? url : "", "t-k"))],
  }
}

/** Numbered UI steps. The copy button copies `copy`, the server URL by default. */
export function stepsSnippet(rows: StepPart[][], url: string, copy: string = url): Snippet {
  return {
    copy,
    lines: rows.map((parts, i) =>
      line(
        token(`${i + 1}  `, "t-p"),
        ...parts.map((part) =>
          typeof part === "string" ? token(part, part === url ? "t-k" : undefined) : token(part.value, "t-s"),
        ),
      ),
    ),
  }
}

/** A snippet written token by token. */
export function rawSnippet(copy: string, lines: SnippetLine[]): Snippet {
  return { copy, lines }
}
