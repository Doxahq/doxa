import { Link } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { Hr, Ticks } from "~/components/marketing/guides"
import { SiteNav } from "~/components/marketing/site-nav"
import { LEGAL_DOC_ORDER, LEGAL_DOCS, type LegalDocId } from "~/lib/marketing/legal"

/**
 * The hero of the legal pages. A document page passes `doc` to show its dates
 * and the tabs that switch between the documents.
 */
export function LegalHero({
  title,
  summary,
  doc,
  children,
}: {
  title: string
  summary: string
  doc?: LegalDocId
  children?: ReactNode
}) {
  const meta = doc ? LEGAL_DOCS[doc] : undefined

  return (
    <header className="hero">
      <div className="hero__glow" aria-hidden="true" />
      <Ticks side="l" ticks={[{ top: 140 }, { top: 226, left: "38%" }, { top: 318 }]} />
      <Ticks side="r" ticks={[{ top: 120 }, { top: 210, right: "30%" }, { top: 300 }]} />
      <SiteNav current="legal" />
      <Hr />
      <div className="col">
        <div className="hero__inner">
          <Link className="chip" to="/legal">
            Legal
          </Link>
          <h1 className="display">{title}</h1>
          <p>{summary}</p>
          {meta ? (
            <div className="meta">
              <span>
                Last updated <b>{meta.updated}</b>
              </span>
              <span>
                Effective <b>{meta.effective}</b>
              </span>
            </div>
          ) : null}
          {doc ? (
            <nav className="tabs" aria-label="Legal documents">
              {LEGAL_DOC_ORDER.map((id) => {
                const on = id === doc
                return (
                  <Link
                    key={id}
                    to={LEGAL_DOCS[id].path}
                    className={on ? "on" : undefined}
                    aria-current={on ? "page" : undefined}
                  >
                    {LEGAL_DOCS[id].title}
                  </Link>
                )
              })}
            </nav>
          ) : null}
          {children}
        </div>
      </div>
    </header>
  )
}
