import { WriteIcon, type WriteIconName } from "~/components/marketing/agent/agent-icons"
import { Hr } from "~/components/marketing/guides"
import { SectionHead } from "~/components/marketing/mcp/section-head"
import { ROUTE_FRAMEWORKS } from "~/lib/marketing/agent"

const CARDS: { icon: WriteIconName; title: string; body: string; wide?: boolean }[] = [
  { icon: "book", title: "Guides", body: "A quickstart, guides and concept pages, planned from how your project works." },
  { icon: "brackets", title: "API reference", body: "One page for each endpoint, built from your OpenAPI 3 or Swagger 2 file." },
  {
    icon: "search",
    title: "No spec? It reads your routes",
    body: "Without a spec file, Doxabot finds the endpoints in your route handlers.",
    wide: true,
  },
  { icon: "table", title: "SDK reference", body: "A reference section for the functions and types your SDK exports." },
  { icon: "lines", title: "Navigation", body: "Sections, groups and page order, ready to browse on day one." },
  { icon: "play", title: "API playground", body: "Turns on the interactive playground when your API can use it." },
  { icon: "code", title: "Code in your languages", body: "Choose up to six languages for the code samples." },
]

/** Section 04: the pages Doxabot writes. */
export function AgentOutput() {
  return (
    <>
      <SectionHead
        label="What it writes"
        chip="What it writes"
        title={
          <>
            A full docs site
            <br />
            <span className="mark">from one repository</span>
          </>
        }
        side={
          <p>
            Guides for people, a reference for every endpoint, and the navigation that ties them together. All of it is
            plain MDX that you can edit.
          </p>
        }
      />
      <Hr label="04 / OUTPUT" />
      <section className="col" aria-label="Pages Doxabot writes">
        <div className="axw">
          {CARDS.map((card) => (
            <div key={card.title} className={card.wide ? "axw__c axw__c--wide" : "axw__c"}>
              <WriteIcon name={card.icon} />
              <h3>{card.title}</h3>
              <p>{card.body}</p>
              {card.wide ? (
                <div className="axfw">
                  {ROUTE_FRAMEWORKS.map((name) => (
                    <span key={name}>{name}</span>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </section>
    </>
  )
}
