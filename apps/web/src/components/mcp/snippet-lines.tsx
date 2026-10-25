import type { SnippetLine } from "~/lib/mcp/snippet"

/** Snippet lines as highlighted spans, for a <pre>. */
export function SnippetLines({ lines }: { lines: SnippetLine[] }) {
  return lines.map((tokens, i) => (
    <div key={i}>
      {tokens.map((tk, j) => (
        <span key={j} className={tk.tone}>
          {tk.text}
        </span>
      ))}
    </div>
  ))
}
