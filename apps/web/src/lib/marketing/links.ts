// Links shared by the marketing pages. Values in brackets are placeholders
// until the real destination exists.

export const GITHUB_URL = "https://github.com/ipenywis/doxa"
export const DOCS_URL = "https://docs.doxa.so"
export const MCP_SERVER_URL = "https://mcp.doxa.so/mcp"
export const DISCORD_URL = "#"
export const X_URL = "#"
export const STATUS_URL = "#"
export const CONTACT_URL = "#"
export const PRIVACY_URL = "#"
export const TERMS_URL = "#"
export const LLMS_TXT_URL = "#"

// Sign-up and sign-in both start at the login page; the dashboard sends a
// signed-out visitor there too.
export const SIGN_IN_URL = "/login"
export const GET_STARTED_URL = "/dashboard"

export type MarketingPage = "home" | "pricing" | "mcp" | "about"
