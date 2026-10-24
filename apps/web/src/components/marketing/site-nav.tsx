import { Link } from "@tanstack/react-router"
import { DoxaMark } from "~/components/marketing/doxa-mark"
import { DOCS_URL, GET_STARTED_URL, SIGN_IN_URL, type MarketingPage } from "~/lib/marketing/links"

type NavItem = { label: string; page?: MarketingPage; to?: string; href?: string }

const NAV: NavItem[] = [
  { label: "Product", page: "home", to: "/" },
  { label: "MCP", page: "mcp", to: "/mcp" },
  { label: "Docs", href: DOCS_URL },
  { label: "Pricing", page: "pricing", to: "/pricing" },
]

type Cta = { label: string; href: string }

const DEFAULT_CTA: Cta = { label: "Get started ›", href: GET_STARTED_URL }

/**
 * The top bar of every marketing page. `current` marks the page in view;
 * `cta` replaces the light button (the MCP page asks to connect an agent).
 */
export function SiteNav({ current, cta = DEFAULT_CTA }: { current: MarketingPage; cta?: Cta }) {
  return (
    <div className="col">
      <nav className="nav" aria-label="Main">
        <Link className="brand" to="/">
          <DoxaMark />
          DOXA
        </Link>
        <div className="nav__links">
          {NAV.map((item) => {
            if (item.href) {
              return (
                <a key={item.label} href={item.href}>
                  {item.label}
                </a>
              )
            }
            // The home link is "Product", so the home page does not mark it.
            const on = item.page === current && current !== "home"
            return (
              <Link
                key={item.label}
                to={item.to}
                className={on ? "on" : undefined}
                aria-current={on ? "page" : undefined}
              >
                {item.label}
              </Link>
            )
          })}
        </div>
        <div className="nav__actions">
          <a className="btn btn--line btn--sm" href={SIGN_IN_URL}>
            Sign in
          </a>
          <a className="btn btn--light btn--sm" href={cta.href}>
            {cta.label}
          </a>
        </div>
      </nav>
    </div>
  )
}
