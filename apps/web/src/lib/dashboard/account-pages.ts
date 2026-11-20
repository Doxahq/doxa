/**
 * The account settings pages in the Account sidebar: their paths and their heading copy.
 * The pages and their skeletons both read this, so the heading is the same before and after the data loads.
 */
export const ACCOUNT_PAGES = {
  account: {
    path: "/dashboard/settings",
    group: "Account",
    title: "Account settings",
    description: "Your profile and your GitHub connection.",
  },
  emailNotifications: {
    path: "/dashboard/settings/notifications",
    group: "Notifications",
    title: "Email notifications",
    description: "The emails that Doxa sends to your account address. Team invites always send.",
  },
  connectedAgents: {
    path: "/dashboard/settings/agents",
    group: "Agents",
    title: "Connected agents",
    description: "Agents that can use your Doxa account through MCP.",
  },
  agentApprovals: {
    path: "/dashboard/settings/approvals",
    group: "Agents",
    title: "Agent approvals",
    description: "What your agents can do without asking you, in every project. A project setting wins over these defaults.",
  },
} as const

export type AccountPage = (typeof ACCOUNT_PAGES)[keyof typeof ACCOUNT_PAGES]

/** True when `pathname` is the page at `path`, with or without a trailing slash. */
export function isAccountPagePath(pathname: string, path: string): boolean {
  return pathname === path || pathname === `${path}/`
}
