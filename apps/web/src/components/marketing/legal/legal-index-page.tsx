import { Link } from "@tanstack/react-router"
import { Band } from "~/components/marketing/band"
import { Hr } from "~/components/marketing/guides"
import { LegalHero } from "~/components/marketing/legal/legal-hero"
import { MarketingPage } from "~/components/marketing/marketing-page"
import { SiteFooter } from "~/components/marketing/site-footer"
import { BANDS } from "~/lib/marketing/bands"
import { LEGAL_DOC_ORDER, LEGAL_DOCS, LEGAL_ENTITY, LEGAL_LOCATION } from "~/lib/marketing/legal"
import { CONTACT_EMAIL, CONTACT_URL } from "~/lib/marketing/links"

export function LegalIndexPage() {
  return (
    <MarketingPage page="legal">
      <LegalHero
        title="Legal"
        summary="The terms that apply when you use the hosted Doxa service, and how we handle the data you trust us with."
      />
      <Hr label="DOCUMENTS" />
      <div className="col">
        <div className="docs">
          {LEGAL_DOC_ORDER.map((id, i) => {
            const meta = LEGAL_DOCS[id]
            return (
              <Link key={id} className="docs__card" to={meta.path}>
                <span className="label">{`0${i + 1} / ${meta.label}`}</span>
                <h2 className="display">{meta.title}</h2>
                <p>{meta.summary}</p>
                <span className="docs__foot">
                  <span>Last updated {meta.updated}</span>
                  <span aria-hidden="true">Read ›</span>
                </span>
              </Link>
            )
          })}
        </div>
        <p className="docs__contact">
          Doxa is a service of {LEGAL_ENTITY}, {LEGAL_LOCATION}. For a question about these documents or a request
          about your data, write to{" "}
          <a href={CONTACT_URL}>{CONTACT_EMAIL}</a>.
        </p>
      </div>
      <Band spec={BANDS.beforeFooter} />
      <SiteFooter />
    </MarketingPage>
  )
}
