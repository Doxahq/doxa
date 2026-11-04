import type { RuntimeMdxComponentName } from "@doxahq/mdx-runtime";

export interface MdxComponentGuide {
  readonly title: string;
  readonly names: readonly RuntimeMdxComponentName[];
  readonly use: string;
  readonly props: readonly string[];
  readonly example: string;
  /** Generated blocks: the generator writes them, an agent keeps them as is. */
  readonly generatedOnly?: boolean;
}

// Follow-up: the generation writer keeps its own copy of this guidance in
// packages/agent (prompt module "writer-component-directives") and in
// apps/docs-template/agent/component-playbook.md. A test checks that this
// list names every component the renderer supports.
export const MDX_COMPONENT_GUIDES: readonly MdxComponentGuide[] = [
  {
    title: "Cards",
    names: ["CardGrid", "Card"],
    use: "2 to 6 navigation links at the start or end of a section.",
    props: [
      "Card: title (string, required), subtitle, description, href, icon (docs icon name), image, variant (\"normal\" | \"small\" | \"image\"), external (boolean)",
    ],
    example: `<CardGrid>
  <Card title="Quickstart" description="Install and run it." href="/quickstart" />
  <Card title="Repository" href="https://github.com/acme/app" external={true} />
</CardGrid>`,
  },
  {
    title: "Notes",
    names: ["Note"],
    use: "Callouts: gotchas, requirements, deprecations, security caveats. There is no Warning, Tip, Callout, or Alert component.",
    props: [
      'Note: title, type ("note" | "success" | "warning" | "danger")',
    ],
    example: `<Note title="Secrets" type="warning">
  Never commit the API key.
</Note>`,
  },
  {
    title: "Steps",
    names: ["Step", "StepItem"],
    use:
      "A sequential procedure of 3 or more actions. Write one Step with a StepItem per step; put each step's text and code inside its StepItem. Step takes no props: <Step title> drops the title and numbers every paragraph as a step.",
    props: ["Step: none", "StepItem: title"],
    example: `<Step>
  <StepItem title="Install">

\`\`\`bash
npm install acme
\`\`\`

  </StepItem>
  <StepItem title="Run">Start the server.</StepItem>
</Step>`,
  },
  {
    title: "Tabs",
    names: ["Tabs", "TabsList", "TabsTrigger", "TabsContent"],
    use: "Alternatives for the same goal: package managers, languages, platforms.",
    props: [
      "Tabs: defaultValue (string, matches a trigger value)",
      "TabsTrigger, TabsContent: value (string)",
    ],
    example: `<Tabs defaultValue="npm">
  <TabsList>
    <TabsTrigger value="npm">npm</TabsTrigger>
    <TabsTrigger value="pnpm">pnpm</TabsTrigger>
  </TabsList>
  <TabsContent value="npm">Run \`npm install acme\`.</TabsContent>
  <TabsContent value="pnpm">Run \`pnpm add acme\`.</TabsContent>
</Tabs>`,
  },
  {
    title: "File tree",
    names: ["FileTree", "Folder", "File"],
    use: "A directory layout of 4 or more entries.",
    props: [
      "Folder: name (string, required), label, open (boolean), defaultOpen (boolean)",
      "File: name (string, required), label",
    ],
    example: `<FileTree>
  <Folder name="src" defaultOpen>
    <File name="index.ts" />
  </Folder>
</FileTree>`,
  },
  {
    title: "Mermaid",
    names: ["Mermaid"],
    use: "A flow or architecture diagram that prose cannot explain as well.",
    props: ["Mermaid: chart (Mermaid source string, required)"],
    example: "<Mermaid chart={`graph TD; A[Client] --> B[API];`} />",
  },
  {
    title: "Video embed",
    names: ["Embed"],
    use: "A YouTube, Vimeo, or Loom video. Paste the address from the browser. Any other address renders as a plain link.",
    props: ["Embed: url (string, required), title (iframe title for screen readers)"],
    example: '<Embed url="https://youtu.be/dQw4w9WgXcQ" title="Quickstart walkthrough" />',
  },
  {
    title: "REST endpoint blocks",
    names: [
      "ApiEndpoint",
      "ApiRequestExample",
      "ApiResponseExample",
      "ApiParams",
      "ApiParam",
    ],
    use: "Generated REST reference blocks. Keep them unchanged; do not write new ones by hand.",
    props: [
      "ApiEndpoint: method, path, baseUrl",
      "ApiRequestExample: client, lang, label",
      "ApiResponseExample: status, contentType",
      "ApiParams: title, detail",
      'ApiParam: name, type, location ("path" | "query" | "header" | "cookie" | "body" | "response"), required (boolean), enum (comma-separated allowed values), example, default',
    ],
    example: "",
    generatedOnly: true,
  },
];

export const MDX_AUTHORING_RULES: readonly string[] = [
  "Start each page with YAML frontmatter: title (required), description, keywords, icon. Values are plain text.",
  "The title comes from frontmatter. Use h2 to h4 headings in the body, never h1.",
  "Do not write import or export statements. The renderer provides the components.",
  "Use only the components below, with only the listed props. Anything else fails the MDX check.",
  "Leave a blank line before and after a code fence inside a component. Give every fence a language.",
  "Escape a literal < or { in prose, or put it in inline code.",
  "GitHub-flavored Markdown works: tables, task lists, blockquotes, images, and fenced code with line highlights such as ```ts {2-3}.",
  "Write an image as ![alt text](/assets/name.png) with the path that upload_asset returns, or an https URL. HTML <img> tags and relative paths do not render.",
];
