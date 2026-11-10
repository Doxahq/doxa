// Links shared by the marketing pages. Values in brackets are placeholders
// until the real destination exists.

export const SITE_ORIGIN = "https://doxa.so"
export const GITHUB_URL = "https://github.com/Doxahq/doxa"
export const DOCS_URL = "https://docs.doxa.so"
export const MCP_SERVER_URL = "https://mcp.doxa.so/mcp"
export const DISCORD_URL = "#"
export const X_URL = "#"
export const STATUS_URL = "#"
export const CONTACT_EMAIL = "hello@doxa.so"
export const CONTACT_URL = `mailto:${CONTACT_EMAIL}`
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
