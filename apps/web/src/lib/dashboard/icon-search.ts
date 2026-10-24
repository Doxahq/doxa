import { docsIconLabel } from "@doxahq/docs-prose/icons"

/** One icon as the picker search sees it. */
export interface IconSearchEntry {
  name: string
  label: string
  /** The words of the name ("book", "open"). */
  nameWords: readonly string[]
  /** Lucide's search words and the extra words of suggested icons. */
  tags: readonly string[]
  /** The name in one lowercase run ("bookopen"), for a search typed without spaces. */
  compact: string
}

export function buildIconSearchEntries(
  names: readonly string[],
  tags: Readonly<Record<string, readonly string[]>> | null,
  extraWords: Readonly<Record<string, readonly string[]>>,
): IconSearchEntry[] {
  return names.map((name) => {
    const label = docsIconLabel(name)
    const nameWords = label.toLowerCase().split(" ")
    return {
      name,
      label,
      nameWords,
      tags: [...(tags?.[name] ?? []), ...(extraWords[name] ?? [])],
      compact: nameWords.join(""),
    }
  })
}

/**
 * The names that match a search, best first. Every word of the search must
 * match the icon name or one of its search words. A word that starts a name
 * word ranks above one that starts a search word, and either ranks above a
 * match inside a word. Word matching instead of a fuzzy score: a fuzzy search
 * for "key" also finds "terminal" and "beaker", which reads as noise in a grid
 * of glyphs.
 */
export function searchIcons(entries: readonly IconSearchEntry[], query: string): string[] {
  const words = query
    .trim()
    .toLowerCase()
    .split(/[\s\-_]+/)
    .filter(Boolean)
  if (words.length === 0) return entries.map((entry) => entry.name)
  const whole = words.join("")

  const scored: { name: string; score: number; length: number }[] = []
  for (const entry of entries) {
    let score = entry.compact === whole ? 100 : 0
    for (const word of words) {
      const wordScore = scoreWord(entry, word)
      if (wordScore === 0) {
        score = 0
        break
      }
      score += wordScore
    }
    if (score > 0) scored.push({ name: entry.name, score, length: entry.compact.length })
  }

  scored.sort((a, b) => b.score - a.score || a.length - b.length || a.name.localeCompare(b.name))
  return scored.map((match) => match.name)
}

function scoreWord(entry: IconSearchEntry, word: string): number {
  if (entry.nameWords.includes(word)) return 8
  if (entry.nameWords.some((nameWord) => nameWord.startsWith(word))) return 6
  if (entry.tags.some((tag) => tag === word)) return 4
  if (entry.tags.some((tag) => tag.split(" ").some((tagWord) => tagWord.startsWith(word)))) return 3
  if (entry.compact.includes(word)) return 2
  if (word.length >= 3 && entry.tags.some((tag) => tag.includes(word))) return 1
  return 0
}
