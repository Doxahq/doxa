import { getRouteApi, Link } from "@tanstack/react-router"
import { ChevronDown } from "lucide-react"
import { DoxaMark } from "~/components/marketing/doxa-mark"
import { GithubIcon } from "~/components/marketing/github-icon"
import { ctaClickHandler } from "~/lib/analytics/capture-browser-event"
import {
  DASHBOARD_URL,
  DOCS_URL,
  GET_STARTED_URL,
  GITHUB_URL,
  SIGN_IN_URL,
  type MarketingPage,
} from "~/lib/marketing/links"

const marketingRoute = getRouteApi("/_marketing")

/** `tag` is a small label after the link text, for example "Beta". */
type NavItem = { label: string; page?: MarketingPage; to?: string; hash?: string; href?: string; tag?: string }

const NAV: NavItem[] = [
  { label: "Agent", page: "agent", to: "/agent", tag: "Beta" },
  { label: "MCP", page: "mcp", to: "/mcp" },
  { label: "Docs", href: DOCS_URL },
  { label: "Pricing", page: "pricing", to: "/pricing" },
]

const RESOURCES: { title: string; items: NavItem[] }[] = [
  {
    title: "Company",
    items: [
      { label: "About", page: "about", to: "/about" },
      { label: "Contact", to: "/about", hash: "contact" },
    ],
  },
  {
    title: "Learn",
    items: [{ label: "Blog", page: "blog", to: "/blog" }],
  },
]

/** `id` is the machine code of the `cta_clicked` event. */
type Cta = { id: string; label: string; href: string }

const DEFAULT_CTA: Cta = { id: "get_started", label: "Get started ›", href: GET_STARTED_URL }

/**
 * Stay static for every visitor, so they show only the light button. The sign-up
 * page sends a signed-in visitor on to the dashboard.
 */
const STATIC_PAGES: ReadonlySet<MarketingPage> = new Set(["agent", "about", "blog", "legal", "mcp"])

/**
 * The top bar of every marketing page. `current` marks the page in view;
 * `cta` replaces the light button (the MCP page asks to connect an agent).
 * On the other pages, a signed-in visitor sees one Dashboard button instead of both.
 */
export function SiteNav({ current, cta = DEFAULT_CTA }: { current: MarketingPage; cta?: Cta }) {
  const { signedIn } = marketingRoute.useLoaderData()
  return (
    <div className="col">
      <nav className="nav" aria-label="Main">
        {/* The logo is the only link to the home page. */}
        <Link className="brand" to="/" aria-label="Doxa home">
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
            const on = item.page === current
            return (
              <Link
                key={item.label}
                to={item.to}
                className={on ? "on" : undefined}
                aria-current={on ? "page" : undefined}
              >
                {item.label}
                {item.tag ? <span className="nav__tag">{item.tag}</span> : null}
              </Link>
            )
          })}
          <ResourcesMenu current={current} />
        </div>
        <div className="nav__actions">
          <a className="nav__github" href={GITHUB_URL} target="_blank" rel="noreferrer" aria-label="Doxa on GitHub">
            <GithubIcon size={18} />
          </a>
          {STATIC_PAGES.has(current) ? (
            <a className="btn btn--light btn--sm" href={cta.href} onClick={ctaClickHandler("nav", cta.id)}>
              {cta.label}
            </a>
          ) : signedIn ? (
            <a className="btn btn--light btn--sm" href={DASHBOARD_URL}>
              Dashboard ›
            </a>
          ) : (
            <>
              <a className="btn btn--line btn--sm" href={SIGN_IN_URL}>
                Sign in
              </a>
              <a className="btn btn--light btn--sm" href={cta.href} onClick={ctaClickHandler("nav", cta.id)}>
                {cta.label}
              </a>
            </>
          )}
        </div>
      </nav>
    </div>
  )
}

/** Opens on hover and on keyboard focus (see shared.css). Each column is one category. */
function ResourcesMenu({ current }: { current: MarketingPage }) {
  const active = RESOURCES.some((group) => group.items.some((item) => item.page === current))
  return (
    <div className="navmenu">
      <button type="button" className={active ? "navmenu__trigger on" : "navmenu__trigger"}>
        Resources
        <ChevronDown aria-hidden="true" size={14} />
      </button>
      <div className="navmenu__panel">
        <div className="navmenu__columns">
          {RESOURCES.map((group) => (
            <div className="navmenu__column" key={group.title}>
              <span className="navmenu__title">{group.title}</span>
              <ul>
                {group.items.map((item) => (
                  <li key={item.label}>
                    {item.href ? (
                      <a href={item.href}>{item.label}</a>
                    ) : (
                      <Link
                        to={item.to}
                        hash={item.hash}
                        // The router does not scroll again when the URL stays the same. On another page
                        // the target does not exist yet, and the router scrolls after the navigation.
                        onClick={() =>
                          item.hash && document.getElementById(item.hash)?.scrollIntoView({ behavior: "smooth" })
                        }
                        className={item.page === current ? "on" : undefined}
                        aria-current={item.page === current ? "page" : undefined}
                      >
                        {item.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
