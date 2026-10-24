// The client catalog of the MCP page: one entry per MCP client, with its
// setup snippet and the copy for each setup step.

import { MCP_SERVER_URL as SERVER_URL } from "~/lib/marketing/links"
import {
  commandSnippet,
  jsonSnippet,
  line,
  rawSnippet,
  stepsSnippet,
  token,
  type Snippet,
} from "~/lib/marketing/mcp-snippet"

export type McpClientGroup = "chat" | "ide" | "cli"

export interface McpClient {
  id: string
  label: string
  /** Logo path. A client without one shows `mono` in a letter tile. */
  logo?: string
  mono?: string
  /** Set on the clients of the "More clients" menu. */
  group?: McpClientGroup
  kind: string
  how: string
  /** Step 02: how to add Doxa. */
  add: string
  /** The snippet title: a file, a settings path or "Terminal". */
  file: string
  copyLabel: string
  snippet: Snippet
  /** The note under the snippet. */
  where: string
  /** Step 03: how the sign-in starts. */
  signIn: string
  /** Step 04: where the connection shows. */
  check: string
}

const logo = (id: string) => `/marketing/logos/${id}.svg`

/** The five clients with their own tab. */
export const MAIN_CLIENTS: McpClient[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    logo: logo("claude"),
    kind: "CLI",
    how: "One command",
    add: "Run one command in your terminal. Claude Code adds Doxa as a remote MCP server.",
    file: "Terminal",
    copyLabel: "Copy command",
    snippet: commandSnippet(`claude mcp add --transport http doxa ${SERVER_URL}`, SERVER_URL),
    where: "Add -s user to use Doxa in every project, not only this folder.",
    signIn: "Run /mcp in Claude Code, pick doxa and choose Authenticate. The Doxa sign-in page opens.",
    check: "Run /mcp. doxa shows as connected, with its tools listed.",
  },
  {
    id: "claude",
    label: "Claude",
    logo: logo("claude"),
    kind: "Web + desktop",
    how: "Connector",
    add: "Add Doxa as a custom connector. It then works in Claude on the web and in the desktop app.",
    file: "Settings › Connectors",
    copyLabel: "Copy URL",
    snippet: stepsSnippet(
      [
        ["Open Settings › Connectors"],
        ["Click Add custom connector"],
        ["Name  ", { value: "Doxa" }],
        ["URL   ", SERVER_URL],
        ["Click Add, then Connect"],
      ],
      SERVER_URL,
    ),
    where: "Paste only the URL. There is no API key or client secret to fill in.",
    signIn: "Click Connect on the Doxa connector. The Doxa sign-in page opens.",
    check: "Open the tools menu in a new chat. Doxa is listed and turned on.",
  },
  {
    id: "cursor",
    label: "Cursor",
    logo: logo("cursor"),
    kind: "Editor",
    how: "mcp.json",
    add: "Add Doxa to the MCP config file of your project, or to your global one.",
    file: ".cursor/mcp.json",
    copyLabel: "Copy config",
    snippet: jsonSnippet({ mcpServers: { doxa: { url: SERVER_URL } } }),
    where: "Use .cursor/mcp.json in your repo, or ~/.cursor/mcp.json for every project.",
    signIn: "Open Cursor Settings › MCP and click the login button next to doxa. The Doxa sign-in page opens.",
    check: "Open Cursor Settings › MCP. doxa has a green dot and lists its tools.",
  },
  {
    id: "vscode",
    label: "VS Code",
    logo: logo("vscode"),
    kind: "Editor",
    how: "mcp.json",
    add: "Add Doxa to the MCP config of your workspace. Copilot agent mode can then use it.",
    file: ".vscode/mcp.json",
    copyLabel: "Copy config",
    snippet: jsonSnippet({ servers: { doxa: { type: "http", url: SERVER_URL } } }),
    where: "Or run MCP: Add Server from the Command Palette and paste the URL.",
    signIn: "Click Start above the doxa entry in mcp.json. VS Code asks you to sign in to Doxa.",
    check: "Run MCP: List Servers from the Command Palette. doxa shows as running.",
  },
  {
    id: "codex",
    label: "Codex",
    logo: logo("codex"),
    kind: "CLI",
    how: "config.toml",
    add: "Add Doxa to your Codex config, then sign in once from the terminal.",
    file: "~/.codex/config.toml",
    copyLabel: "Copy config",
    snippet: rawSnippet(`[mcp_servers.doxa]\nurl = "${SERVER_URL}"`, [
      line(token("[mcp_servers.doxa]", "t-k")),
      line(token("url = "), token(`"${SERVER_URL}"`, "t-s")),
    ]),
    where: "Codex keeps the sign-in token, so you sign in only once.",
    signIn: "Run codex mcp login doxa. The Doxa sign-in page opens.",
    check: "Run codex mcp list. doxa is in the list.",
  },
]

/** The clients of the "More clients" menu, in menu order. */
export const MORE_CLIENTS: McpClient[] = [
  // Chat apps
  {
    id: "chatgpt",
    group: "chat",
    label: "ChatGPT",
    logo: logo("chatgpt"),
    kind: "Chat app",
    how: "Developer mode",
    add: "Add Doxa as a custom connector in developer mode.",
    file: "Settings › Apps & Connectors",
    copyLabel: "Copy URL",
    snippet: stepsSnippet(
      [
        ["Open Settings › Apps & Connectors"],
        ["Turn on Developer mode in Advanced settings"],
        ["Click Create"],
        ["URL   ", SERVER_URL],
        ["Auth  ", { value: "OAuth" }],
      ],
      SERVER_URL,
    ),
    where: "Developer mode is on paid ChatGPT plans.",
    signIn: "Click Create. ChatGPT opens the Doxa sign-in page.",
    check: "Open the connector menu in a new chat. Doxa is listed.",
  },
  {
    id: "lechat",
    group: "chat",
    label: "Le Chat",
    logo: logo("lechat"),
    kind: "Chat app",
    how: "Connector",
    add: "Add Doxa as a custom MCP connector in Le Chat by Mistral.",
    file: "Intelligence › Connectors",
    copyLabel: "Copy URL",
    snippet: stepsSnippet(
      [
        ["Open Intelligence › Connectors"],
        ["Click Add connector"],
        ["Pick Custom MCP connector"],
        ["Name  ", { value: "Doxa" }],
        ["URL   ", SERVER_URL],
      ],
      SERVER_URL,
    ),
    where: "Paste only the URL. Le Chat finds the sign-in page by itself.",
    signIn: "Click Connect. Le Chat opens the Doxa sign-in page.",
    check: "Open the tools menu in a new chat. Doxa is listed.",
  },
  {
    id: "cherry",
    group: "chat",
    label: "Cherry Studio",
    logo: logo("cherry"),
    kind: "Chat app",
    how: "Settings",
    add: "Add Doxa as an MCP server in the Cherry Studio settings.",
    file: "Settings › MCP Servers",
    copyLabel: "Copy URL",
    snippet: stepsSnippet(
      [
        ["Open Settings › MCP Servers"],
        ["Click Add Server"],
        ["Type  ", { value: "Streamable HTTP" }],
        ["URL   ", SERVER_URL],
        ["Click Save"],
      ],
      SERVER_URL,
    ),
    where: "Turn the server on in the chat input bar to use it in a chat.",
    signIn: "Save the server. Cherry Studio opens the Doxa sign-in page.",
    check: "Open Settings › MCP Servers. doxa is on and lists its tools.",
  },
  {
    id: "lmstudio",
    group: "chat",
    label: "LM Studio",
    logo: logo("lmstudio"),
    kind: "Desktop app",
    how: "mcp.json",
    add: "Add Doxa to the mcp.json file of LM Studio.",
    file: "Program › Edit mcp.json",
    copyLabel: "Copy config",
    snippet: jsonSnippet({ mcpServers: { doxa: { url: SERVER_URL } } }),
    where: "Open the Program tab in the right panel, then Install › Edit mcp.json.",
    signIn: "Save mcp.json. LM Studio opens the Doxa sign-in page.",
    check: "Open the Program tab. doxa is listed and turned on.",
  },
  // Editors and IDEs
  {
    id: "windsurf",
    group: "ide",
    label: "Windsurf",
    logo: logo("windsurf"),
    kind: "Editor",
    how: "mcp_config.json",
    add: "Add Doxa to the MCP config of Windsurf. Cascade can then use it.",
    file: "~/.codeium/windsurf/mcp_config.json",
    copyLabel: "Copy config",
    snippet: jsonSnippet({ mcpServers: { doxa: { serverUrl: SERVER_URL } } }),
    where: "Windsurf uses serverUrl, not url, for remote servers.",
    signIn: "Refresh the MCP servers in Cascade. The Doxa sign-in page opens.",
    check: "Open the MCP servers list in Cascade. doxa lists its tools.",
  },
  {
    id: "zed",
    group: "ide",
    label: "Zed",
    logo: logo("zed"),
    kind: "Editor",
    how: "settings.json",
    add: "Add Doxa as a context server in your Zed settings.",
    file: "~/.config/zed/settings.json",
    copyLabel: "Copy config",
    snippet: jsonSnippet({ context_servers: { doxa: { url: SERVER_URL } } }),
    where: "Merge the context_servers key into your existing settings.",
    signIn: "Zed opens the Doxa sign-in page when it first connects.",
    check: "Open the Agent panel settings. doxa has a green dot.",
  },
  {
    id: "jetbrains",
    group: "ide",
    label: "JetBrains IDEs",
    logo: logo("jetbrains"),
    kind: "IDE",
    how: "AI Assistant",
    add: "Add Doxa to AI Assistant in IntelliJ IDEA, PyCharm, WebStorm and the other JetBrains IDEs.",
    file: "Settings › Tools › AI Assistant › MCP",
    copyLabel: "Copy config",
    snippet: jsonSnippet({ mcpServers: { doxa: { url: SERVER_URL } } }),
    where: "Click Add, choose As JSON and paste the config.",
    signIn: "Apply the settings. The IDE opens the Doxa sign-in page.",
    check: "Open the MCP settings again. doxa shows as connected.",
  },
  {
    id: "visualstudio",
    group: "ide",
    label: "Visual Studio",
    logo: logo("visualstudio"),
    kind: "IDE",
    how: ".mcp.json",
    add: "Add Doxa to the MCP config of your solution. Copilot agent mode can then use it.",
    file: ".mcp.json",
    copyLabel: "Copy config",
    snippet: jsonSnippet({ servers: { doxa: { type: "http", url: SERVER_URL } } }),
    where: "Put .mcp.json next to your solution file, or in %USERPROFILE% for every solution.",
    signIn: "Open Copilot Chat in agent mode. Visual Studio asks you to sign in to Doxa.",
    check: "Open the tools list in Copilot Chat. The doxa tools are listed.",
  },
  {
    id: "kiro",
    group: "ide",
    label: "Kiro",
    mono: "K",
    kind: "Editor",
    how: "mcp.json",
    add: "Add Doxa to the MCP config of your Kiro workspace.",
    file: ".kiro/settings/mcp.json",
    copyLabel: "Copy config",
    snippet: jsonSnippet({ mcpServers: { doxa: { url: SERVER_URL } } }),
    where: "Use ~/.kiro/settings/mcp.json to use Doxa in every workspace.",
    signIn: "Kiro opens the Doxa sign-in page when it first connects.",
    check: "Open the MCP servers view in the Kiro panel. doxa is connected.",
  },
  {
    id: "trae",
    group: "ide",
    label: "Trae",
    logo: logo("trae"),
    kind: "Editor",
    how: "Settings",
    add: "Add Doxa as an MCP server in the Trae settings.",
    file: "Settings › MCP › Add manually",
    copyLabel: "Copy config",
    snippet: jsonSnippet({ mcpServers: { doxa: { url: SERVER_URL } } }),
    where: "Click Add, then Add manually, and paste the config.",
    signIn: "Confirm the server. Trae opens the Doxa sign-in page.",
    check: "Open Settings › MCP. doxa is listed and turned on.",
  },
  {
    id: "cline",
    group: "ide",
    label: "Cline",
    logo: logo("cline"),
    kind: "Extension",
    how: "Remote server",
    add: "Add Doxa as a remote server in the Cline extension.",
    file: "cline_mcp_settings.json",
    copyLabel: "Copy config",
    snippet: jsonSnippet({ mcpServers: { doxa: { type: "streamableHttp", url: SERVER_URL } } }),
    where: "Or open MCP Servers › Remote Servers in Cline and paste the URL.",
    signIn: "Cline opens the Doxa sign-in page when it first connects.",
    check: "Open MCP Servers › Installed. doxa has a green dot.",
  },
  {
    id: "kilocode",
    group: "ide",
    label: "Kilo Code",
    logo: logo("kilocode"),
    kind: "Extension",
    how: "mcp.json",
    add: "Add Doxa to the MCP config of your project in Kilo Code.",
    file: ".kilocode/mcp.json",
    copyLabel: "Copy config",
    snippet: jsonSnippet({ mcpServers: { doxa: { type: "streamable-http", url: SERVER_URL } } }),
    where: "Or add it to the global MCP settings to use Doxa in every project.",
    signIn: "Kilo Code opens the Doxa sign-in page when it first connects.",
    check: "Open the MCP servers view. doxa is on and lists its tools.",
  },
  // CLI agents
  {
    id: "gemini",
    group: "cli",
    label: "Gemini CLI",
    logo: logo("gemini"),
    kind: "CLI",
    how: "One command",
    add: "Run one command in your terminal. Gemini CLI adds Doxa to its settings.",
    file: "Terminal",
    copyLabel: "Copy command",
    snippet: commandSnippet(`gemini mcp add --transport http doxa ${SERVER_URL}`, SERVER_URL),
    where: "Add -s user to use Doxa in every project.",
    signIn: "Run /mcp auth doxa in Gemini CLI. The Doxa sign-in page opens.",
    check: "Run /mcp. doxa shows as connected, with its tools listed.",
  },
  {
    id: "copilot-cli",
    group: "cli",
    label: "Copilot CLI",
    mono: "GH",
    kind: "CLI",
    how: "mcp-config.json",
    add: "Add Doxa to the MCP config of GitHub Copilot CLI.",
    file: "~/.copilot/mcp-config.json",
    copyLabel: "Copy config",
    snippet: jsonSnippet({ mcpServers: { doxa: { type: "http", url: SERVER_URL } } }),
    where: "Or run /mcp add in Copilot CLI and paste the URL.",
    signIn: "Copilot CLI opens the Doxa sign-in page when it first connects.",
    check: "Run /mcp show. doxa is in the list.",
  },
  {
    id: "opencode",
    group: "cli",
    label: "opencode",
    logo: logo("opencode"),
    kind: "CLI",
    how: "opencode.json",
    add: "Add Doxa as a remote server in your opencode config.",
    file: "opencode.json",
    copyLabel: "Copy config",
    snippet: jsonSnippet({ mcp: { doxa: { type: "remote", url: SERVER_URL } } }),
    where: "Use ~/.config/opencode/opencode.json to use Doxa in every project.",
    signIn: "Run opencode mcp auth doxa. The Doxa sign-in page opens.",
    check: "Run opencode mcp list. doxa is in the list.",
  },
  {
    id: "amp",
    group: "cli",
    label: "Amp",
    logo: logo("amp"),
    kind: "CLI",
    how: "One command",
    add: "Run one command in your terminal. Amp adds Doxa as a remote MCP server.",
    file: "Terminal",
    copyLabel: "Copy command",
    snippet: commandSnippet(`amp mcp add doxa ${SERVER_URL}`, SERVER_URL),
    where: "The same server then works in the Amp editor extension too.",
    signIn: "Amp opens the Doxa sign-in page when it first connects.",
    check: "Run amp mcp list. doxa is in the list.",
  },
  {
    id: "warp",
    group: "cli",
    label: "Warp",
    logo: logo("warp"),
    kind: "Terminal",
    how: "Settings",
    add: "Add Doxa as an MCP server in the Warp settings. Warp agents can then use it.",
    file: "Settings › AI › MCP servers",
    copyLabel: "Copy config",
    snippet: jsonSnippet({ doxa: { url: SERVER_URL } }),
    where: "Click Add, then paste the config.",
    signIn: "Start the server. Warp opens the Doxa sign-in page.",
    check: "Open Settings › AI › MCP servers. doxa shows as running.",
  },
]

/** The fallback for a client that is not in the list. */
export const ANY_CLIENT: McpClient = {
  id: "other",
  label: "Any other client",
  mono: "+",
  kind: "Any client",
  how: "Server URL",
  add: "Any client that supports remote MCP servers can connect. Give it these three values.",
  file: "Connection details",
  copyLabel: "Copy URL",
  snippet: rawSnippet(SERVER_URL, [
    line(token("Server URL  ", "t-p"), token(SERVER_URL, "t-k")),
    line(token("Transport   ", "t-p"), token("Streamable HTTP")),
    line(token("Auth        ", "t-p"), token("OAuth", "t-s"), token(" · the client registers itself")),
  ]),
  where: "Your client registers itself with Doxa. You only sign in.",
  signIn: "Connect the server in your client. The Doxa sign-in page opens.",
  check: "Open the MCP or tools list of your client. doxa shows its tools.",
}

export const ALL_CLIENTS: McpClient[] = [...MAIN_CLIENTS, ...MORE_CLIENTS, ANY_CLIENT]

export const DEFAULT_CLIENT_ID = "claude-code"

/** The client with this id, or Claude Code. */
export function findClient(id: string): McpClient {
  return ALL_CLIENTS.find((c) => c.id === id) ?? MAIN_CLIENTS[0]
}

/** True when the client sits behind the "More clients" button (the menu or "any"). */
export function isMoreClient(id: string): boolean {
  return !MAIN_CLIENTS.some((c) => c.id === findClient(id).id)
}

const MENU_GROUPS: { key: McpClientGroup; name: string }[] = [
  { key: "chat", name: "Chat apps" },
  { key: "ide", name: "Editors and IDEs" },
  { key: "cli", name: "CLI and terminal" },
]

export interface McpMenuGroup {
  key: McpClientGroup
  name: string
  clients: McpClient[]
}

/** Matches the query against the name, kind and setup method, ignoring case. */
export function matchesClient(client: McpClient, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return `${client.label} ${client.kind} ${client.how}`.toLowerCase().includes(q)
}

/** The menu groups with the clients that match the query; empty groups are left out. */
export function menuGroups(query: string): McpMenuGroup[] {
  return MENU_GROUPS.map(({ key, name }) => ({
    key,
    name,
    clients: MORE_CLIENTS.filter((c) => c.group === key && matchesClient(c, query)),
  })).filter((g) => g.clients.length > 0)
}

/** "17 clients", or "3 of 17" while a search is on. */
export function menuCountLabel(query: string, shown: number): string {
  const total = MORE_CLIENTS.length
  return query.trim() ? `${shown} of ${total}` : `${total} clients`
}

/** The logos stacked on the idle "More clients" button, and the "+N" after them. */
export const MORE_STACK_IDS = ["chatgpt", "windsurf", "gemini"] as const

export function moreStack(): { logos: string[]; count: string } {
  const logos = MORE_STACK_IDS.map((id) => MORE_CLIENTS.find((c) => c.id === id)?.logo ?? "")
  return { logos, count: `+${MORE_CLIENTS.length - MORE_STACK_IDS.length}` }
}

/** The name and caption of the "More clients" button for the active client. */
export function moreButtonText(active: McpClient): { label: string; how: string } {
  return isMoreClient(active.id)
    ? { label: active.label, how: `${active.kind} · Change client` }
    : { label: "More clients", how: `${MORE_CLIENTS.length} more, or any MCP client` }
}
