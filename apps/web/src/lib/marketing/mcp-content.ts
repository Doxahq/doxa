// Static content of the MCP page: starter prompts, approval defaults and the
// tool catalog.

export interface StarterPrompt {
  name: string
  text: string
  desc: string
}

export const STARTER_PROMPTS: StarterPrompt[] = [
  {
    name: "write_guide",
    text: "Write a quickstart guide for our API and send me the preview.",
    desc: "Plans and writes a new guide page on a branch, then builds a preview.",
  },
  {
    name: "update_from_code_change",
    text: "Update the docs for the changes in my last pull request.",
    desc: "Finds the pages a code change affects and updates them on a branch.",
  },
  {
    name: "review_branch",
    text: "Review my docs branch before I publish it.",
    desc: "Checks links, MDX and style in the branch diff before a publish.",
  },
  {
    name: "fix_broken_links",
    text: "Find and fix the broken links in our docs.",
    desc: "Finds links to missing pages and fixes them on a branch.",
  },
]

export const TEST_PROMPT = "List my Doxa projects"

export type ApprovalMode = "req" | "allow"

export interface ApprovalDefault {
  title: string
  mode: ApprovalMode
  note?: string
}

export const APPROVAL_MODE_LABEL: Record<ApprovalMode, string> = {
  req: "Requires approval",
  allow: "Allowed",
}

export const APPROVAL_DEFAULTS: ApprovalDefault[] = [
  { title: "Publish a branch", mode: "req" },
  { title: "Restore a publication", mode: "req" },
  { title: "Add a custom domain", mode: "req" },
  { title: "Remove a custom domain", mode: "req" },
  { title: "Generate the docs", mode: "req" },
  { title: "Delete a project", mode: "req", note: "Can never be set to Allow" },
  { title: "Create a project", mode: "allow" },
  { title: "Check a custom domain", mode: "allow" },
  { title: "Cancel a generation", mode: "allow" },
]

export interface ToolGroup {
  name: string
  count: string
  tools: { name: string; gated?: boolean }[]
}

const t = (name: string, gated = false) => (gated ? { name, gated } : { name })

export const TOOL_GROUPS: ToolGroup[] = [
  {
    name: "Projects",
    count: "05",
    tools: [t("list_projects"), t("get_project"), t("create_project"), t("delete_project", true), t("list_github_repositories")],
  },
  {
    name: "Docs",
    count: "06",
    tools: [t("get_docs_structure"), t("read_page"), t("write_page"), t("edit_docs"), t("search_docs"), t("upload_asset")],
  },
  {
    name: "Branches",
    count: "07",
    tools: [
      t("list_branches"),
      t("create_branch"),
      t("delete_branch"),
      t("get_branch_status"),
      t("get_branch_diff"),
      t("sync_branch"),
      t("build_preview"),
    ],
  },
  { name: "Publish", count: "03", tools: [t("publish_branch", true), t("list_publications"), t("restore_publication", true)] },
  { name: "Domains", count: "04", tools: [t("list_domains"), t("add_domain", true), t("check_domain"), t("remove_domain", true)] },
  { name: "Generation", count: "03", tools: [t("start_generation", true), t("get_generation"), t("cancel_generation")] },
  { name: "Site", count: "02", tools: [t("get_site_settings"), t("update_site_settings")] },
  {
    name: "Approvals",
    count: "03",
    tools: [t("list_approval_requests"), t("get_approval_request"), t("cancel_approval_request")],
  },
  { name: "Account", count: "01", tools: [t("get_account")] },
]
