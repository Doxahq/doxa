// Links shared by the marketing pages. Values in brackets are placeholders
// until the real destination exists.

export const SITE_ORIGIN = "https://doxa.so"
export const SITE_NAME = "Doxa"

/** An absolute URL on the marketing site, as search engines and share cards need. */
export function absoluteUrl(path: string): string {
  return new URL(path, SITE_ORIGIN).toString()
}

export const GITHUB_URL = "https://github.com/Doxahq/doxa"
export const SELF_HOSTING_GUIDE_URL = `${GITHUB_URL}/blob/main/docs/current/self-hosting.md`
export const DOCS_URL = "https://docs.doxa.so"
export const MCP_SERVER_URL = "https://mcp.doxa.so/mcp"
export const X_URL = "https://x.com/ipenywis"
export const STATUS_URL = "#"
export const CONTACT_EMAIL = "hello@doxa.so"
export const CONTACT_URL = `mailto:${CONTACT_EMAIL}`
export const DEMO_URL = "https://cal.com/coderone/doxa-demo"
export const CODERONE_URL = "https://youtube.com/coderone"
export const PRIVACY_URL = "/legal/privacy"
export const TERMS_URL = "/legal/terms"
export const LLMS_TXT_URL = "/llms.txt"

// "Get started" opens the sign-up page and "Sign in" the login page. Both send a
// signed-in visitor on to the dashboard.
export const SIGN_IN_URL = "/login"
export const GET_STARTED_URL = "/signup"
export const DASHBOARD_URL = "/dashboard"

export type MarketingPage = "home" | "agent" | "pricing" | "mcp" | "about" | "legal" | "blog"

// The one-line prompt that "Onboard your agent" copies. The agent reads auth.md, starts
// a claim, and shows the user a link and a code (docs/current/agent-signup.md).
export const AGENT_SETUP_URL = `${SITE_ORIGIN}/auth.md`
export const AGENT_SETUP_PROMPT = `Read ${AGENT_SETUP_URL} and follow the steps to connect me to Doxa.`
