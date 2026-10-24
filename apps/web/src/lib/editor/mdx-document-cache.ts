import { parseMdxDocument, type MdxDocument } from "~/lib/editor/mdx-document"

/** Enough for switching back and forth between a few pages, and for a revert. */
const PARSE_LIMIT = 8
const parsed = new Map<string, MdxDocument>()

/**
 * `parseMdxDocument` for the Write editor, remembered for the last few
 * sources. Opening a page again, or reloading a source the editor already
 * had, then costs no parse.
 *
 * The parse reads only the text, so the same text always gives the same
 * document. The text itself is the key: a hash could collide, and the branch
 * or the page would add nothing. The document is shared between editors, so
 * it must be treated as read-only.
 */
export function parseMdxDocumentCached(source: string): MdxDocument {
  let document = parsed.get(source)
  if (document) {
    // Most recently used last, so eviction drops the oldest page.
    parsed.delete(source)
  } else {
    document = parseMdxDocument(source)
  }
  parsed.set(source, document)
  while (parsed.size > PARSE_LIMIT) parsed.delete(parsed.keys().next().value!)
  return document
}
