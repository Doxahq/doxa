import { Link } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { DoxaMark } from "~/components/marketing/doxa-mark"
import { Hr } from "~/components/marketing/guides"
import {
  CODERONE_URL,
  CONTACT_EMAIL,
  CONTACT_URL,
  DISCORD_URL,
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
      { label: "Discord", href: DISCORD_URL },
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

/** The footer of every marketing page, ending in the large "DOXA" mark. */
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
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                  <path d="M2 2l12 12M14 2L2 14" />
                </svg>
              </a>
              <a href={DISCORD_URL} aria-label="Discord">
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
                  <path d="M4 4.5c3-1.4 7-1.4 10 0l1.5 7.5c-1.5 1.3-3.2 2-4.5 2.2L10 12.6M8 12.6l-1 1.6c-1.3-.2-3-.9-4.5-2.2z" />
                  <circle cx="6.6" cy="9" r="1" />
                  <circle cx="11.4" cy="9" r="1" />
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
          <a className="status" href={STATUS_URL}>
            <i />
            ALL SYSTEMS NORMAL
          </a>
          <span className="label foot__credit">
            © 2026 Doxa · Made in <a href={CODERONE_URL}>CoderOne Labs</a> ·{" "}
            <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
          </span>
        </div>
      </div>
      <Hr />
      <div className="foot__mark" aria-hidden="true">
        <span>DOXA</span>
      </div>
    </footer>
  )
}
