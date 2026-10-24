import {
  Component,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import {
  ARTICLE_PROSE_CLASS,
  createProseComponents,
  RuntimeMdxContent,
  type ProseHighlighter,
} from "@doxahq/docs-prose"
import { collectFenceLanguages, parseRuntimeMdx, type RuntimeMdxDocument } from "@doxahq/mdx-runtime"

import { ArrowUpRight } from "lucide-react"

import {
  PREVIEW_COMPONENT_OVERRIDES,
  PREVIEW_ELEMENT_OVERRIDES,
  PREVIEW_FILE_TREE_ICONS,
} from "~/components/dashboard/content/preview-components"
import { resolveDocsIcon } from "~/components/dashboard/content/docs-icon"
import { loadDocsHighlighter, peekDocsHighlighter, type LazyDocsHighlighter } from "~/lib/editor/docs-highlighter"

/**
 * Rendered view of the page being edited.
 *
 * The parser, the node walk, the article typography, and the prose components
 * all come from the packages the published renderer uses, so what an author
 * sees here is what the page becomes once it is published.
 *
 * It draws with whatever theme surrounds it. Place it inside a `SiteCanvas` so
 * it takes the site's colors, fonts and color mode.
 *
 * Everything is guarded. An author types through many invalid states — a bare
 * `<`, an unclosed tag, a half-written expression — and the parser throws on
 * all of them. A preview that crashes on those is unusable.
 */
const previewComponents = createProseComponents({
  resolveIcon: resolveDocsIcon,
  externalIcon: ArrowUpRight,
  fileTreeIcons: PREVIEW_FILE_TREE_ICONS,
  overrides: PREVIEW_COMPONENT_OVERRIDES,
})

export default function MdxPreview({
  source,
  variant = "page",
  placeholder = null,
}: {
  source: string
  /**
   * `page` draws the whole article: title, description and body, laid out as
   * the docs page lays them out. `block` draws only the content, for one block
   * inside an article that the caller already provides.
   */
  variant?: "page" | "block"
  /**
   * What a block shows on its first frame, before it draws. Give it the
   * block's drawn size, so the page does not move.
   */
  placeholder?: ReactNode
}) {
  // Highlighting a document costs real work per fence. Deferring keeps typing
  // responsive on a long page; the preview catches up a frame later.
  // A block starts from `null`: a page with many locked blocks then opens
  // with their placeholders, and the blocks draw in the background, after
  // the page is on screen.
  const deferredSource = useDeferredValue<string | null>(source, variant === "block" ? null : undefined)
  const highlighter = usePreviewHighlighter(source)
  const parsed = useMemo(
    () => (deferredSource === null ? null : parsePreviewSource(deferredSource, highlighter)),
    [deferredSource, highlighter],
  )

  if (parsed === null) return placeholder
  if (!source.trim()) {
    return <PreviewNotice title="Nothing to preview" detail="Start typing to see the page." />
  }
  if (!parsed.ok) {
    return <PreviewNotice title="This page cannot be parsed yet" detail={parsed.error} />
  }

  const { document } = parsed
  // Remount per source so a component that threw once is retried instead of
  // leaving the error notice on screen for the rest of the session.
  const content = (
    <PreviewErrorBoundary key={deferredSource}>
      <RuntimeMdxContent
        document={document}
        components={previewComponents}
        elements={PREVIEW_ELEMENT_OVERRIDES}
        fallbackComponent={UnknownComponent}
      />
    </PreviewErrorBoundary>
  )

  if (variant === "block") return content

  const { title, description } = document.frontmatter

  // The same article structure as the docs route: title, description, then
  // the body in `.prose-content`, which the shared code-block rules are scoped to.
  return (
    <div className="px-6 py-6">
      <article className={ARTICLE_PROSE_CLASS}>
        {title ? (
          <h1 className="not-prose text-3xl font-bold tracking-tight lg:text-4xl">{title}</h1>
        ) : null}
        {description ? (
          <p className="not-prose mt-3 text-lg text-muted-foreground">{description}</p>
        ) : null}
        <div className={title || description ? "prose-content mt-8" : "prose-content"}>{content}</div>
      </article>
    </div>
  )
}

type ParsedPreview =
  | { ok: true; document: RuntimeMdxDocument }
  | { ok: false; error: string }

function parsePreviewSource(
  source: string,
  highlighter: ProseHighlighter | null,
): ParsedPreview {
  try {
    const document = parseRuntimeMdx(source, {
      sourceLabel: "preview",
      ...(highlighter ? { highlighter } : {}),
    })
    return { ok: true, document }
  } catch (error) {
    return { ok: false, error: toMessage(error) }
  }
}

/**
 * The docs highlighter, with the grammars of this source's code fences.
 *
 * The highlighter and each grammar load on demand, so on a first visit they
 * arrive after the first paint. Until then the preview shows plain code
 * fences, which is the same fallback the parser uses when no highlighter is
 * supplied. A fence whose grammar is still loading stays plain the same way.
 *
 * Each load that brings new grammars gives a new highlighter object, so the
 * source is parsed again with it. `covers` holds the languages that were all
 * ready when the object was made: while the source uses the same languages,
 * nothing loads again.
 */
function usePreviewHighlighter(source: string): ProseHighlighter | null {
  const languages = useMemo(() => collectFenceLanguages(source), [source])
  const languagesKey = languages.join(" ")
  const [state, setState] = useState<{ highlighter: ProseHighlighter | null; covers: string | null }>(() => {
    const loaded = peekDocsHighlighter()
    if (!loaded) return { highlighter: null, covers: null }
    const covers = languages.every((language) => loaded.isReady(language)) ? languagesKey : null
    return { highlighter: proseHighlighter(loaded), covers }
  })

  useEffect(() => {
    if (state.covers === languagesKey) return
    let active = true
    void loadDocsHighlighter().then(async (loaded) => {
      const wanted = languagesKey ? languagesKey.split(" ") : []
      await loaded.load(wanted.filter((language) => !loaded.isReady(language)))
      if (active) setState({ highlighter: proseHighlighter(loaded), covers: languagesKey })
    })
    return () => {
      active = false
    }
  }, [languagesKey, state.covers])

  return state.highlighter
}

/** A new object each time, so the parse memo runs again with the new grammars. */
function proseHighlighter(loaded: LazyDocsHighlighter): ProseHighlighter {
  return { codeToHast: loaded.parserHighlighter.codeToHast }
}

/**
 * Stands in for a component name the registry does not carry.
 *
 * The published renderer throws on one, which is right at build time and wrong
 * in a live editor: a half-typed tag name must not blank the page.
 */
function UnknownComponent({ children }: { children?: ReactNode }) {
  return (
    <div className="not-prose my-4 rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
      {children}
    </div>
  )
}

function PreviewNotice({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="m-6 rounded-md border border-dashed px-4 py-5">
      <p className="font-mono text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
        {title}
      </p>
      <p className="mt-2 font-mono text-xs leading-5 break-words text-foreground/70">
        {detail}
      </p>
    </div>
  )
}

/**
 * Catches a render failure so the editor keeps working.
 *
 * A component that rejects a prop shape throws during render. Showing the
 * message is the feedback an author needs; unmounting the editor is not.
 */
class PreviewErrorBoundary extends Component<
  { children: ReactNode },
  { message: string | null }
> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { message: null }
  }

  static getDerivedStateFromError(error: unknown) {
    return { message: toMessage(error) }
  }

  render() {
    if (this.state.message !== null) {
      return <PreviewNotice title="This page cannot be rendered yet" detail={this.state.message} />
    }
    return this.props.children
  }
}

function toMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  // The parser prefixes its own context. Keep the part an author can act on.
  return message.replace(/^Failed to parse runtime MDX(?: for [^:]+)?:\s*/, "")
}
