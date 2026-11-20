import { Link } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { DoxaMark } from "~/components/marketing/doxa-mark"
import { Hr } from "~/components/marketing/guides"
import { FooterMark } from "~/components/marketing/footer-mark"
import { OnboardAgentButton } from "~/components/marketing/onboard-agent-button"
import { ThemeSwitch } from "~/components/marketing/theme-switch"
import {
  CODERONE_URL,
  CONTACT_EMAIL,
  CONTACT_URL,
  DOCS_URL,
  GITHUB_URL,
  LLMS_TXT_URL,
  PRIVACY_URL,
  STATUS_URL,
  TERMS_URL,
  X_URL,
} from "~/lib/marketing/links"

type FooterLink = { label: string; to?: string; href?: string }

const COLUMNS: { title: string; links: FooterLink[] }[] = [
  {
    title: "Product",
    links: [
      { label: "Doxabot", to: "/agent" },
      { label: "Docs Platform", to: "/" },
      { label: "MCP Server", to: "/mcp" },
      { label: "Pricing", to: "/pricing" },
    ],
  },
  {
    title: "Developers",
    links: [
      { label: "Documentation", href: DOCS_URL },
      { label: "Demo docs", href: DOCS_URL },
      { label: "llms.txt", href: LLMS_TXT_URL },
    ],
  },
  {
    title: "Community",
    links: [
      { label: "GitHub", href: GITHUB_URL },
      { label: "X / Twitter", href: X_URL },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "About", to: "/about" },
      { label: "Blog", to: "/blog" },
      { label: "Contact", href: CONTACT_URL },
    ],
  },
  {
    title: "Legal",
    links: [
      { label: "Privacy", href: PRIVACY_URL },
      { label: "Terms", href: TERMS_URL },
    ],
  },
]

function FooterAnchor({ link }: { link: FooterLink }): ReactNode {
  if (link.to) return <Link to={link.to}>{link.label}</Link>
  return <a href={link.href}>{link.label}</a>
}

/**
 * The footer of every marketing page: the link columns, the status link with
 * the theme switch, and the large pixel "DOXA" mark with "Onboard your agent" on top.
 */
export function SiteFooter() {
  return (
    <footer className="foot">
      <div className="col">
        <div className="foot__grid">
          <div className="foot__brand">
            <span className="foot__logo">
              <DoxaMark />
              DOXA
            </span>
            <div className="foot__social">
              <a href={GITHUB_URL} aria-label="GitHub">
                <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true">
                  <path
                    fill="currentColor"
                    d="M8 0a8 8 0 0 0-2.5 15.6c.4 0 .5-.2.5-.4v-1.5c-2.2.5-2.7-1-2.7-1-.4-.9-.9-1.2-.9-1.2-.7-.5.1-.5.1-.5.8.1 1.2.8 1.2.8.7 1.3 1.9.9 2.3.7.1-.5.3-.9.5-1.1-1.8-.2-3.6-.9-3.6-4 0-.9.3-1.6.8-2.1-.1-.2-.4-1 .1-2.1 0 0 .7-.2 2.2.8a7.6 7.6 0 0 1 4 0c1.5-1 2.2-.8 2.2-.8.4 1.1.2 1.9.1 2.1.5.6.8 1.3.8 2.1 0 3.1-1.9 3.8-3.6 4 .3.3.6.8.6 1.5v2.2c0 .2.1.5.6.4A8 8 0 0 0 8 0z"
                  />
                </svg>
              </a>
              <a href={X_URL} aria-label="X">
                <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    fill="currentColor"
                    d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"
                  />
                </svg>
              </a>
            </div>
          </div>
          {COLUMNS.map((col) => (
            <nav className="foot__col" aria-label={col.title} key={col.title}>
              <span className="label">{col.title}</span>
              {col.links.map((link) => (
                <FooterAnchor link={link} key={link.label} />
              ))}
            </nav>
          ))}
        </div>
      </div>
      <Hr />
      <div className="col">
        <div className="foot__base">
          <div className="foot__start">
            <a className="status" href={STATUS_URL} target="_blank" rel="noopener noreferrer">
              <i />
              ALL SYSTEMS NORMAL
            </a>
            <ThemeSwitch />
          </div>
          <span className="label foot__credit">
            © 2026 Doxa · Made in <a href={CODERONE_URL}>CoderOne Labs</a> ·{" "}
            <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
          </span>
        </div>
      </div>
      <Hr />
      <div className="foot__mark">
        <FooterMark />
        <OnboardAgentButton className="foot__agent" />
      </div>
    </footer>
  )
}
