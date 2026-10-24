import { useEffect, useRef, useState, type RefObject } from "react"
import type { Editor } from "@tiptap/core"
import { useEditorState } from "@tiptap/react"
import { activeTocIndex, tocScrollTargets, tocTriggers, type TocScrollMetrics } from "@doxahq/docs-prose"

import { cn } from "~/lib/utils"

interface OutlineHeading {
  level: number
  text: string
  pos: number
}

/** The distance of the reading line below the top of the editor, in pixels. */
const READING_OFFSET = 96

/** Scrolling that stops for this long ends a scroll started from the outline. */
const CLICK_SCROLL_SETTLE_MS = 150

/**
 * "On this page": the H2 and H3 headings, with the current one marked (see
 * `tocTriggers` in `@doxahq/docs-prose`). It sits in the site canvas with the published table of
 * contents' layout, but marks the current heading in the text color, not the
 * site's accent color: it is editor chrome.
 */
export function PageOutline({
  editor,
  scrollRef,
}: {
  editor: Editor
  scrollRef: RefObject<HTMLElement | null>
}) {
  const headings = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const found: OutlineHeading[] = []
      current.state.doc.forEach((node, offset) => {
        const level = Number(node.attrs.level)
        if (node.type.name === "heading" && (level === 2 || level === 3) && node.textContent.trim()) {
          found.push({ level, text: node.textContent, pos: offset })
        }
      })
      return found
    },
  })
  const [activePos, setActivePos] = useState<number | null>(null)
  // While a click scrolls to a heading, that heading stays marked and the
  // headings it passes on the way are not.
  const clickLockRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const scroller = scrollRef.current
    if (!scroller || headings.length === 0) return
    let frame: number | null = null

    const update = () => {
      frame = null
      if (clickLockRef.current) return
      const triggers = tocTriggers(headingTops(editor, headings, scroller), scrollMetrics(scroller))
      const index = activeTocIndex(triggers, scroller.scrollTop)
      setActivePos(headings[index]?.pos ?? null)
    }
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(update)
    }
    const onScroll = () => {
      if (clickLockRef.current) holdClickLock(clickLockRef)
      schedule()
    }

    update()
    scroller.addEventListener("scroll", onScroll, { passive: true })
    // Edits, images and pane width move the headings without a scroll.
    const resizeObserver = new ResizeObserver(schedule)
    resizeObserver.observe(scroller)
    resizeObserver.observe(editor.view.dom)
    return () => {
      if (frame !== null) cancelAnimationFrame(frame)
      scroller.removeEventListener("scroll", onScroll)
      resizeObserver.disconnect()
    }
  }, [editor, headings, scrollRef])

  useEffect(
    () => () => {
      if (clickLockRef.current) clearTimeout(clickLockRef.current)
    },
    [],
  )

  function scrollToHeading(index: number) {
    const scroller = scrollRef.current
    const heading = headings[index]
    if (!scroller || !heading) return
    holdClickLock(clickLockRef)
    setActivePos(heading.pos)
    // The heading is still current when the scroll stops. A heading near the
    // end of the page stops below the reading line.
    const targets = tocScrollTargets(headingTops(editor, headings, scroller), scrollMetrics(scroller))
    scroller.scrollTo({ top: targets[index] ?? 0, behavior: "smooth" })
  }

  if (headings.length === 0) return null

  return (
    <nav aria-label="On this page" className="sticky top-6 w-[200px] shrink-0 self-start pt-[180px] max-[1240px]:hidden">
      <span className="mb-3 block text-sm font-semibold text-foreground">On this page</span>
      <ol className="flex flex-col border-l border-border/50">
        {headings.map((heading, index) => (
          <li key={heading.pos}>
            <button
              type="button"
              aria-current={heading.pos === activePos ? "location" : undefined}
              onClick={() => scrollToHeading(index)}
              className={cn(
                "-ml-px block w-full truncate border-l-2 py-1.5 pr-1 text-left text-sm hover:text-foreground",
                heading.level === 3 ? "pl-6" : "pl-3",
                heading.pos === activePos
                  ? "border-foreground font-medium text-foreground"
                  : "border-transparent text-muted-foreground",
              )}
            >
              {heading.text}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  )
}

/** Holds the click lock until scrolling stops for `CLICK_SCROLL_SETTLE_MS`. */
function holdClickLock(lock: RefObject<ReturnType<typeof setTimeout> | null>) {
  if (lock.current) clearTimeout(lock.current)
  lock.current = setTimeout(() => {
    lock.current = null
  }, CLICK_SCROLL_SETTLE_MS)
}

/** Each heading's top in the scroll content. A heading not drawn yet sorts last. */
function headingTops(editor: Editor, headings: OutlineHeading[], scroller: HTMLElement): number[] {
  const scrollerTop = scroller.getBoundingClientRect().top
  return headings.map((heading) => {
    const element = editor.view.nodeDOM(heading.pos)
    return element instanceof HTMLElement
      ? element.getBoundingClientRect().top - scrollerTop + scroller.scrollTop
      : Number.POSITIVE_INFINITY
  })
}

function scrollMetrics(scroller: HTMLElement): TocScrollMetrics {
  return {
    maxScroll: scroller.scrollHeight - scroller.clientHeight,
    viewportHeight: scroller.clientHeight,
    readingOffset: READING_OFFSET,
  }
}
