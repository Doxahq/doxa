import {
  markdownSectionText,
  splitMarkdownSections,
} from "../utils/markdown-sections";

/** Headings down to this level split a Markdown evidence file. */
const EVIDENCE_SECTION_MAX_LEVEL = 3;
/** One heading hit, or three body hits, makes a section relevant. */
const HEADING_HIT_WEIGHT = 3;
const MIN_RELEVANT_SECTION_SCORE = 3;
const MIN_TOPIC_WORD_LENGTH = 4;
/** Words share a stem when their first six letters match (deploy, deployment). */
const TOPIC_STEM_LENGTH = 6;
const MARKDOWN_PATH = /\.(?:md|mdx|markdown)$/i;
const STOP_WORDS = new Set([
  "about",
  "after",
  "also",
  "before",
  "docs",
  "documentation",
  "each",
  "from",
  "guide",
  "have",
  "into",
  "learn",
  "more",
  "page",
  "public",
  "that",
  "their",
  "them",
  "then",
  "this",
  "used",
  "uses",
  "using",
  "what",
  "when",
  "which",
  "with",
  "your",
]);

export interface TopicExcerpt {
  text: string;
  /** Headings of the Markdown sections chosen for the page topic. */
  sections: string[];
}

/** Sorted, unique word stems of the given texts, without stop words. */
export function topicStems(texts: readonly string[]): string[] {
  const stems = new Set<string>();
  for (const text of texts) {
    for (const word of text.toLowerCase().split(/[^a-z0-9]+/)) {
      if (word.length < MIN_TOPIC_WORD_LENGTH || STOP_WORDS.has(word)) continue;
      stems.add(word.slice(0, TOPIC_STEM_LENGTH));
    }
  }
  return Array.from(stems).sort();
}

export function isMarkdownPath(path: string): boolean {
  return MARKDOWN_PATH.test(path);
}

/**
 * The Markdown sections of a file that match the page topic, best match
 * first, cut to `maxChars` and printed in file order. Returns null when no
 * section matches or the file cannot be split.
 */
export function topicSectionExcerpt(
  content: string,
  stems: readonly string[],
  maxChars: number,
): TopicExcerpt | null {
  if (stems.length === 0) return null;
  const layout = splitMarkdownSections(content, EVIDENCE_SECTION_MAX_LEVEL);
  if (!layout) return null;

  const stemSet = new Set(stems);
  const ranked = layout.sections
    .map((section) => {
      const text = markdownSectionText(layout, section);
      return {
        section,
        text,
        score:
          HEADING_HIT_WEIGHT * countHits(section.heading, stemSet) +
          countHits(text, stemSet),
      };
    })
    .filter((candidate) => candidate.score >= MIN_RELEVANT_SECTION_SCORE)
    .sort((left, right) =>
      right.score - left.score ||
      left.section.startLine - right.section.startLine
    );

  const chosen: typeof ranked = [];
  let remaining = maxChars;
  for (const candidate of ranked) {
    if (remaining <= 0) break;
    const text = candidate.text.slice(0, remaining);
    chosen.push({ ...candidate, text });
    remaining -= text.length + 2;
  }
  if (chosen.length === 0) return null;

  chosen.sort((left, right) => left.section.startLine - right.section.startLine);
  return {
    text: chosen.map((candidate) => candidate.text).join("\n\n").slice(0, maxChars),
    sections: chosen.map((candidate) => candidate.section.heading),
  };
}

function countHits(text: string, stems: ReadonlySet<string>): number {
  return topicStems([text]).filter((stem) => stems.has(stem)).length;
}
