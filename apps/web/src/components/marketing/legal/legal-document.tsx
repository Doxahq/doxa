import type { ReactNode } from "react"
import { Band } from "~/components/marketing/band"
import { Hr } from "~/components/marketing/guides"
import { LegalHero } from "~/components/marketing/legal/legal-hero"
import { MarketingPage } from "~/components/marketing/marketing-page"
import { SiteFooter } from "~/components/marketing/site-footer"
import { BANDS } from "~/lib/marketing/bands"
import { LEGAL_DOCS, type LegalDocId } from "~/lib/marketing/legal"

export interface LegalSection {
  /** The anchor of the section, so `/legal/privacy#cookies` links to it. */
  id: string
  title: string
  body: ReactNode
}

/** Two digits, so the section numbers line up in the contents list. */
function sectionNumber(index: number) {
  return String(index + 1).padStart(2, "0")
}

/** A legal document page: hero, a contents list, and the numbered sections. */
export function LegalDocument({
  doc,
  intro,
  sections,
}: {
  doc: LegalDocId
  intro: ReactNode
  sections: LegalSection[]
}) {
  const meta = LEGAL_DOCS[doc]

  return (
    <MarketingPage page="legal">
      <LegalHero title={meta.title} summary={meta.summary} doc={doc} />
      <Hr label="CONTENTS" />
      <div className="col">
        <div className="doc">
          <nav className="doc__toc" aria-label="On this page">
            <div>
              <span className="label">On this page</span>
              <ol>
                {sections.map((section, i) => (
                  <li key={section.id}>
                    <a href={`#${section.id}`}>
                      <span>{sectionNumber(i)}</span>
                      {section.title}
                    </a>
                  </li>
                ))}
              </ol>
            </div>
          </nav>
          <article className="doc__body">
            <div className="doc__intro">{intro}</div>
            {sections.map((section, i) => (
              <section key={section.id} id={section.id} aria-labelledby={`${section.id}-title`}>
                <h2 id={`${section.id}-title`}>
                  <span className="n">{sectionNumber(i)}</span>
                  {section.title}
                </h2>
                {section.body}
              </section>
            ))}
          </article>
        </div>
      </div>
      <Band spec={BANDS.beforeFooter} />
      <SiteFooter />
    </MarketingPage>
  )
}
