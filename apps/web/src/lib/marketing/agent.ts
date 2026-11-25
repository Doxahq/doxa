// Copy for the Doxabot page (/agent). The page uses the product name, Doxabot,
// everywhere. Copy in square brackets is a placeholder for
// a fact that is not decided yet.

import { ALL_CLIENTS } from "~/lib/mcp/clients"

/** The agent's name in the dashboard, the GitHub check and the emails. */
export const AGENT_NAME = "Doxabot"

export interface AgentStep {
  who: "You" | typeof AGENT_NAME
  title: string
  body: string
}

export const AGENT_STEPS: AgentStep[] = [
  {
    who: "You",
    title: "Connect GitHub",
    body: "Install the Doxa GitHub App on the repositories you choose. It asks to read code and pull requests, and nothing more.",
  },
  {
    who: AGENT_NAME,
    title: "First generation",
    body: "Doxabot maps the codebase, plans the sections, and writes the guides, the API reference and the navigation.",
  },
  {
    who: AGENT_NAME,
    title: "Preview each pull request",
    body: "When a pull request changes code, Doxabot rewrites the pages it touches. A GitHub check links to the preview.",
  },
  {
    who: "You",
    title: "Review and publish",
    body: "After the merge, the update waits in a review. Accept or reject each page, then publish.",
  },
]

/** Route frameworks the agent reads when a repository has no OpenAPI or Swagger file. */
export const ROUTE_FRAMEWORKS = [
  "Express",
  "Hono",
  "Fastify",
  "Koa",
  "NestJS",
  "Spring",
  "FastAPI",
  "Flask",
  "Django",
  "Gin",
  "Echo",
  "Chi",
  "ASP.NET",
  "Laravel",
  "Axum",
  "Actix",
]

/** Agent files that the agent also reads as context, next to `.doxa/instructions.md`. */
export const AGENT_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  "copilot-instructions.md",
  ".cursorrules",
  ".windsurfrules",
]

/** GitHub App permissions, as GitHub shows them during installation. */
export const GITHUB_PERMISSIONS = ["Contents · read", "Pull requests · read", "Checks · write", "Metadata · read"]

/** The agents in the "Your AI tools" card, in this order. */
export const AGENT_PAGE_CLIENTS = ["claude-code", "cursor", "vscode", "codex"].flatMap((id) => {
  const client = ALL_CLIENTS.find((c) => c.id === id)
  return client?.logo ? [{ id, label: client.label, logo: client.logo }] : []
})

/** An answer is plain text, or text runs where `{ ph }` is a placeholder. */
export type AgentFaqRun = string | { ph: string } | { link: string; to: string }

export const AGENT_FAQ: { q: string; a: AgentFaqRun[] }[] = [
  {
    q: "What is Doxabot?",
    a: [
      "Doxabot is an AI agent that documents your code. It reads a GitHub repository, writes a docs site with guides and an API reference, and updates it when your code changes. You approve every update before it goes live.",
    ],
  },
  {
    q: "Where do I find Doxabot?",
    a: [
      "In the dashboard, open a project and choose Doxabot in the sidebar. That page holds its instructions, pull request previews, the merge schedule and the generation cache.",
    ],
  },
  {
    q: "Does Doxabot change my repository?",
    a: [
      "No. The Doxa GitHub App reads code and pull requests. Its only write access is the check run that links to the docs preview. Doxabot writes its changes to branches inside Doxa.",
    ],
  },
  {
    q: "Can it publish without me?",
    a: [
      "The first generation publishes to your new, empty docs site. After that, every update waits in a review, and you choose which pages go live.",
    ],
  },
  {
    q: "Which languages and frameworks does it support?",
    a: [
      `It reads any GitHub repository. For the API reference it uses your OpenAPI 3 or Swagger 2 file. Without a spec, it reads route handlers in ${ROUTE_FRAMEWORKS.slice(0, -1).join(", ")} and ${ROUTE_FRAMEWORKS.at(-1)}.`,
    ],
  },
  {
    q: "When does it update the docs?",
    a: [
      "It builds a preview for each open pull request. After a merge into your default branch, it runs on the schedule you pick: after every merge, once merges stop for a quiet period (30 minutes by default), or only when you start it.",
    ],
  },
  {
    q: "Does it work with public repositories, GitLab or Bitbucket?",
    a: [
      "It works with public and private GitHub repositories. It ignores pull requests from forks. ",
      { ph: "[GITLAB AND BITBUCKET PLANS]" },
    ],
  },
  {
    q: "Which AI models does it use?",
    a: ["It runs on Anthropic's Claude models. Claude Sonnet plans the site and Claude Haiku writes the pages."],
  },
  {
    q: "Is Doxabot on the Free plan?",
    a: [{ ph: "[AGENT PLAN AVAILABILITY]" }, " See ", { link: "pricing", to: "/pricing" }, "."],
  },
]
