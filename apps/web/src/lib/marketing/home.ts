import type { CSSProperties } from "react"

/** Agents in the "Works with your agent" row. Logos live in /marketing/logos. */
export const AGENT_LOGOS = [
  { name: "Claude", logo: "/marketing/logos/claude.svg" },
  { name: "Cursor", logo: "/marketing/logos/cursor.svg" },
  { name: "VS Code", logo: "/marketing/logos/vscode.svg" },
  { name: "Codex", logo: "/marketing/logos/codex.svg" },
  { name: "OpenCode", logo: "/marketing/logos/opencode.svg" },
]

/** Feature rows in the Docs Platform card. */
export const PLATFORM_ROWS = [
  { icon: "⌘", label: "Search & AI chat" },
  { icon: "≡", label: "llms.txt for agents" },
  { icon: "⑂", label: "Branches & previews" },
  { icon: "@", label: "Custom domains" },
]

/** Clients that light up in turn in the MCP Server card. */
export const MCP_CLIENTS = [
  { name: "Claude", delay: undefined },
  { name: "Cursor", delay: "2s" },
  { name: "Codex", delay: "4s" },
]

export type DiagramNode = { title: string; detail: string; agent?: boolean; style: CSSProperties }

/** One straight part of an arrow in the agent diagram; `dir` is the way the signal runs. */
type AgentDiagramLeg = { dir: "down" | "up" | "right"; style: CSSProperties }

/** The Doxa Agent diagram: repo → agent → preview → live docs. */
export const AGENT_DIAGRAM = {
  gems: [
    { left: "4%", top: "72%", background: "#3d7bff" },
    { left: "52%", top: "6%", background: "#c4a1ff", animationDelay: "-3s" },
    { left: "92%", top: "56%", background: "#9cc2ff", animationDelay: "-6s" },
  ] satisfies CSSProperties[],
  // One signal runs the arrows in story order. `start` is when it reaches each arrow, in seconds.
  arrows: [
    {
      start: 0,
      legs: [
        { dir: "down", style: { left: "17%", top: "25%", height: "25%" } },
        { dir: "right", style: { left: "17%", top: "50%", width: "16%" } },
      ],
    },
    {
      start: 5,
      legs: [
        { dir: "up", style: { left: "50%", top: "16%", height: "24%" } },
        { dir: "right", style: { left: "50%", top: "16%", width: "16%" } },
      ],
    },
    {
      start: 10,
      legs: [
        { dir: "right", style: { left: "67%", top: "56%", width: "16%" } },
        { dir: "down", style: { left: "83%", top: "56%", height: "22%" } },
      ],
    },
  ] satisfies { start: number; legs: [AgentDiagramLeg, AgentDiagramLeg] }[],
  nodes: [
    { title: "YOUR REPO", detail: "main · src/api", style: { left: "0", top: "4%", width: "34%" } },
    { title: "DOXA AGENT", detail: "reading diff…", agent: true, style: { left: "33%", top: "40%", width: "34%" } },
    { title: "PREVIEW", detail: "doxa/sync-142", style: { left: "66%", top: "4%", width: "34%" } },
    { title: "LIVE DOCS", detail: "acme.doxa.so", style: { left: "66%", top: "78%", width: "34%" } },
  ] satisfies DiagramNode[],
  tags: [
    { label: "PR #142 MERGED", left: "2%", top: "30%" },
    { label: "3 PAGES", left: "36%", top: "69%" },
    { label: "41 S", left: "52%", top: "69%" },
    { label: "PREVIEW READY", left: "70%", top: "31%" },
    { label: "WAITS FOR YOU", left: "56%", top: "92%" },
  ],
}

/** The diff in the "Code changes. Docs follow." pane. */
export const SAMPLE_DIFF = [
  { kind: "del", line: "- export async function getUsers() {" },
  { kind: "add", line: "+ export async function getUsers(limit?: number) {" },
  { kind: "del", line: "-   return db.users.findMany();" },
  { kind: "add", line: "+   return db.users.findMany({ take: limit });" },
] as const

export const REVIEW_FILES = [
  { path: "api/users.mdx", added: 12, removed: 4 },
  { path: "guides/pagination.mdx", added: 8, removed: 1 },
  { path: "changelog.mdx", added: 3, removed: 0 },
]

/** The tree in the "doxa · export" window. `prefix` keeps its trailing spaces. */
export const EXPORT_TREE = [
  { prefix: "├─ ", name: "pages/" },
  { prefix: "│  ├─ ", name: "index.mdx" },
  { prefix: "│  ├─ ", name: "quickstart.mdx" },
  { prefix: "│  └─ ", name: "guides/auth.mdx" },
  { prefix: "├─ ", name: "assets/" },
]

/** Sparks around the rocket's engine in the closing scene. */
export const EMBERS = [
  { tone: "", left: "40%", top: "74%", delay: "0s" },
  { tone: "ice", left: "46%", top: "77%", delay: "-0.7s" },
  { tone: "", left: "55%", top: "73%", delay: "-1.5s" },
  { tone: "lav", left: "60%", top: "78%", delay: "-2.2s" },
  { tone: "", left: "35%", top: "79%", delay: "-2.9s" },
  { tone: "ice", left: "64%", top: "75%", delay: "-3.6s" },
  { tone: "", left: "51%", top: "76%", delay: "-1.1s" },
]
