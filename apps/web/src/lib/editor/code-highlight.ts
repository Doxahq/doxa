import { Extension } from "@tiptap/core"
import type { Node as ProseMirrorNode } from "@tiptap/pm/model"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"
import { resolveFenceLanguage } from "@doxahq/mdx-runtime"

import { loadDocsHighlighter, peekDocsHighlighter, type LazyDocsHighlighter } from "~/lib/editor/docs-highlighter"

/**
 * Colors code blocks as the published site does: the same grammars, the same
 * fence language names, and the same light and dark themes. Each token
 * carries both colors as `--shiki-light` and `--shiki-dark`, and the stylesheet
 * picks one by the canvas's color mode, like the site's `.shiki` rules.
 *
 * The highlighter loads after the editor opens, and it loads only the
 * grammars of the page's code blocks. Until a block's grammar is ready, its
 * code is plain, as on the site before its highlighter arrives.
 *
 * Tokens are computed in idle time, not inside the transaction that changes
 * the page. The first block of a language costs the most (the grammar is
 * compiled then), and it must not block opening a page or typing. While a
 * block waits for new tokens, it keeps its old colors, moved with the edit.
 */

interface CodeHighlightState {
  highlighter: LazyDocsHighlighter | null
  decorations: DecorationSet
  /** True when a block's grammar is ready but its tokens are not computed yet. */
  pending: boolean
}

/** A transaction meta: the highlighter has loaded, or new grammars or tokens are ready. */
type CodeHighlightMeta = { highlighter: LazyDocsHighlighter } | { refresh: true }

const KEY = new PluginKey<CodeHighlightState>("codeHighlight")

/** One code block's token spans, relative to its start. Kept per block text. */
type TokenSpan = { from: number; to: number; style: string }
const TOKEN_CACHE_LIMIT = 200
const tokenCache = new Map<string, TokenSpan[]>()
/** The cache always holds a whole page, so a long page cannot evict its own blocks. */
let tokenCacheLimit = TOKEN_CACHE_LIMIT

const cacheKey = (language: string, code: string) => `${language}\u0000${code}`

function cachedSpans(language: string, code: string): TokenSpan[] | undefined {
  const key = cacheKey(language, code)
  const spans = tokenCache.get(key)
  if (spans) {
    // Most recently used last, so eviction drops blocks no page shows anymore.
    tokenCache.delete(key)
    tokenCache.set(key, spans)
  }
  return spans
}

function computeSpans(highlighter: LazyDocsHighlighter, language: string, code: string): TokenSpan[] {
  let spans: TokenSpan[] = []
  try {
    const { tokens } = highlighter.shiki.codeToTokens(code, {
      lang: language,
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: false,
    })
    spans = tokens.flat().flatMap((token) => {
      const style = token.htmlStyle
        ? Object.entries(token.htmlStyle)
            .filter(([name]) => name === "--shiki-light" || name === "--shiki-dark")
            .map(([name, value]) => `${name}:${value}`)
            .join(";")
        : ""
      return style && token.content.length > 0
        ? [{ from: token.offset, to: token.offset + token.content.length, style }]
        : []
    })
  } catch {
    spans = []
  }
  while (tokenCache.size >= tokenCacheLimit) tokenCache.delete(tokenCache.keys().next().value!)
  tokenCache.set(cacheKey(language, code), spans)
  return spans
}

/** A code block the highlighter can color now: its grammar is loaded and it has text. */
function readyBlock(node: ProseMirrorNode, highlighter: LazyDocsHighlighter): { language: string; code: string } | null {
  const language = resolveFenceLanguage(String(node.attrs.language ?? ""))
  if (!language || node.textContent.length === 0 || !highlighter.isReady(language)) return null
  return { language, code: node.textContent }
}

/**
 * The grammar names of a page's code blocks, each once, in page order. A block
 * with no language or an unknown one is left out.
 */
export function collectCodeBlockLanguages(doc: ProseMirrorNode): string[] {
  const languages = new Set<string>()
  doc.descendants((node) => {
    if (node.type.name !== "codeBlock") return true
    const language = resolveFenceLanguage(String(node.attrs.language ?? ""))
    if (language) languages.add(language)
    return false
  })
  return [...languages]
}

/**
 * Decorations from the tokens computed so far. A block without tokens yet
 * keeps the decorations it had before this change, so it does not flash plain.
 */
function buildDecorations(
  doc: ProseMirrorNode,
  highlighter: LazyDocsHighlighter,
  previous: DecorationSet,
): Pick<CodeHighlightState, "decorations" | "pending"> {
  const decorations: Decoration[] = []
  let pending = false
  let blocks = 0
  doc.descendants((node, pos) => {
    if (node.type.name !== "codeBlock") return true
    blocks += 1
    const block = readyBlock(node, highlighter)
    if (!block) return false
    const start = pos + 1
    const spans = cachedSpans(block.language, block.code)
    if (spans) {
      for (const span of spans) {
        decorations.push(Decoration.inline(start + span.from, start + span.to, { class: "doxa-code-token", style: span.style }))
      }
    } else {
      pending = true
      decorations.push(...previous.find(start, start + node.content.size))
    }
    return false
  })
  tokenCacheLimit = Math.max(TOKEN_CACHE_LIMIT, blocks * 2)
  return { decorations: DecorationSet.create(doc, decorations), pending }
}

type IdleDeadlineLike = { timeRemaining: () => number }

/** Runs work when the browser is idle, or within 200 ms at most. */
function whenIdle(run: (deadline: IdleDeadlineLike) => void): () => void {
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(run, { timeout: 200 })
    return () => cancelIdleCallback(id)
  }
  const id = setTimeout(() => {
    const end = performance.now() + 8
    run({ timeRemaining: () => Math.max(0, end - performance.now()) })
  }, 1)
  return () => clearTimeout(id)
}

export const CodeHighlight = Extension.create({
  name: "codeHighlight",
  addProseMirrorPlugins() {
    return [
      new Plugin<CodeHighlightState>({
        key: KEY,
        state: {
          // When the highlighter loaded for an earlier page, a page opened
          // again draws its cached colors on the first paint.
          init: (_config, state) => {
            const highlighter = peekDocsHighlighter()
            if (!highlighter) return { highlighter: null, decorations: DecorationSet.empty, pending: false }
            return { highlighter, ...buildDecorations(state.doc, highlighter, DecorationSet.empty) }
          },
          apply(tr, value, _oldState, newState) {
            const meta = tr.getMeta(KEY) as CodeHighlightMeta | undefined
            if (!meta && !tr.docChanged) return value
            const highlighter = meta && "highlighter" in meta ? meta.highlighter : value.highlighter
            if (!highlighter) return value
            const previous = tr.docChanged ? value.decorations.map(tr.mapping, tr.doc) : value.decorations
            return { highlighter, ...buildDecorations(newState.doc, highlighter, previous) }
          },
        },
        props: {
          decorations: (state) => KEY.getState(state)?.decorations ?? DecorationSet.empty,
        },
        view(view) {
          let active = true
          let highlighter: LazyDocsHighlighter | null = KEY.getState(view.state)?.highlighter ?? null
          let cancelIdle: (() => void) | null = null
          let scannedDoc: ProseMirrorNode | null = null

          const refresh = () => {
            if (active && !view.isDestroyed) view.dispatch(view.state.tr.setMeta(KEY, { refresh: true }))
          }

          // Computes the missing tokens, one block after another, until the
          // idle time runs out. Each run computes at least one block.
          const tokenizePending = (deadline: IdleDeadlineLike) => {
            cancelIdle = null
            if (!active || !highlighter || view.isDestroyed) return
            const current = highlighter
            let computed = 0
            view.state.doc.descendants((node) => {
              if (node.type.name !== "codeBlock") return true
              if (computed > 0 && deadline.timeRemaining() <= 0) return false
              const block = readyBlock(node, current)
              if (block && !tokenCache.has(cacheKey(block.language, block.code))) {
                computeSpans(current, block.language, block.code)
                computed += 1
              }
              return false
            })
            // The refresh draws the new tokens. If blocks are left, `update` schedules the next run.
            if (computed > 0) refresh()
          }

          const update = () => {
            if (!active || !highlighter) return
            const current = highlighter
            const { doc } = view.state
            if (doc !== scannedDoc) {
              scannedDoc = doc
              const missing = collectCodeBlockLanguages(doc).filter((language) => !current.isReady(language))
              if (missing.length > 0) void current.load(missing).then(refresh)
            }
            if (KEY.getState(view.state)?.pending && !cancelIdle) cancelIdle = whenIdle(tokenizePending)
          }

          if (highlighter) {
            update()
          } else {
            // The highlighter loads on demand, after the editor opens.
            void loadDocsHighlighter().then((loaded) => {
              if (!active || view.isDestroyed) return
              highlighter = loaded
              view.dispatch(view.state.tr.setMeta(KEY, { highlighter: loaded }))
            })
          }

          return {
            update,
            destroy: () => {
              active = false
              cancelIdle?.()
              cancelIdle = null
            },
          }
        },
      }),
    ]
  },
})
