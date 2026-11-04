import { activeTocIndex, tocScrollTargets, tocTriggers, type TocScrollMetrics } from "@doxahq/docs-prose"
import type { RuntimeMdxHeading } from "@doxahq/mdx-runtime"
import { useNavigate } from "@tanstack/react-router"
import { useEffect, useState, type MouseEvent } from "react"

/** The reading line, the same as the headings' `scroll-margin-top` in blog.css. */
const READING_OFFSET = 32

/** Each heading's top on the page, in page order. */
function headingTops(headings: RuntimeMdxHeading[]) {
  return headings.map((heading) => {
    const element = document.getElementById(heading.href.slice(1))
    return element ? element.getBoundingClientRect().top + window.scrollY : 0
  })
}

function scrollMetrics(): TocScrollMetrics {
  return {
    maxScroll: document.documentElement.scrollHeight - window.innerHeight,
    viewportHeight: window.innerHeight,
    readingOffset: READING_OFFSET,
  }
}

/** The post's contents list, with the current section marked as the page scrolls. */
export function BlogToc({ headings }: { headings: RuntimeMdxHeading[] }) {
  const navigate = useNavigate()
  const [activeIndex, setActiveIndex] = useState(0)

  useEffect(() => {
    let frame: number | null = null
    const update = () => {
      frame = null
      setActiveIndex(activeTocIndex(tocTriggers(headingTops(headings), scrollMetrics()), window.scrollY))
    }
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(update)
    }

    update()
    window.addEventListener("scroll", schedule, { passive: true })
    window.addEventListener("resize", schedule)
    return () => {
      if (frame !== null) cancelAnimationFrame(frame)
      window.removeEventListener("scroll", schedule)
      window.removeEventListener("resize", schedule)
    }
  }, [headings])

  const scrollToHeading = (event: MouseEvent, index: number) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey) return
    event.preventDefault()
    const top = tocScrollTargets(headingTops(headings), scrollMetrics())[index]
    void navigate({
      to: ".",
      hash: headings[index].href.slice(1),
      replace: true,
      resetScroll: false,
      hashScrollIntoView: false,
    })
    window.scrollTo({ top, behavior: "smooth" })
  }

  return (
    <ul className="post-toc">
      {headings.map((heading, i) => (
        <li key={heading.href}>
          <a
            href={heading.href}
            className={[heading.level === 3 ? "sub" : "", i === activeIndex ? "on" : ""].join(" ").trim() || undefined}
            aria-current={i === activeIndex ? "location" : undefined}
            onClick={(event) => scrollToHeading(event, i)}
          >
            {heading.text}
          </a>
        </li>
      ))}
    </ul>
  )
}
