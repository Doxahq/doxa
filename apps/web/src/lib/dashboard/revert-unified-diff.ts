const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/

/** The 0-based line of the new text where a hunk starts. An empty side names the line before it. */
function hunkStart(header: RegExpExecArray): number {
  const line = Number(header[1])
  return header[2] === "0" ? line : line - 1
}

/**
 * Pure: the text before the edit that `diff` describes, from the text after
 * it. A stored diff can end at its size limit, so the text past the cut stays
 * as it is. Null when the diff does not fit the text, for example when a newer
 * edit changed the same lines.
 */
export function revertUnifiedDiff(after: string, diff: string): string | null {
  const afterLines = after.split("\n")
  const diffLines = diff.replace(/\n$/, "").split("\n")
  const firstHunk = diffLines.findIndex((line) => line.startsWith("@@"))
  if (firstHunk === -1) return null

  const before: string[] = []
  let cursor = 0
  for (let index = firstHunk; index < diffLines.length; index += 1) {
    const line = diffLines[index] ?? ""
    const header = HUNK_HEADER.exec(line)
    if (header !== null) {
      const start = hunkStart(header)
      if (start < cursor || start > afterLines.length) return null
      before.push(...afterLines.slice(cursor, start))
      cursor = start
    } else if (line.startsWith("-")) {
      before.push(line.slice(1))
    } else if (line.startsWith(" ") || line.startsWith("+")) {
      if (afterLines[cursor] !== line.slice(1)) {
        // The size limit can cut the last line in the middle.
        if (index === diffLines.length - 1) break
        return null
      }
      if (line.startsWith(" ")) before.push(line.slice(1))
      cursor += 1
    }
  }
  return [...before, ...afterLines.slice(cursor)].join("\n")
}
