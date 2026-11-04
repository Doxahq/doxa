import { REPO_MAP_EXPLORATION_MAX_STEPS } from "../../constants";
import { resolveDocumentationBrief, resolveDocumentationPolicy } from "../../documentation-policy";
import { renderProjectInstructionsBlock } from "../../project-instructions";
import {
  formatAnalysisSummary,
  formatPublicEditorialBrief,
  formatStructureSummary,
} from "./formatters";
import type { PromptModule, PromptStage } from "./types";

function bulletList(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

const PUBLIC_POLICY_STAGES: PromptStage[] = [
  "exploration",
  "analysis",
  "structure",
  "structure-review",
  "writer",
  "incremental-analysis",
  "ordering",
];

/**
 * The repo map renders last in the system prompt. It is the same for every
 * call on one source tree, so it stays inside the cached prefix; nothing in
 * it changes per call (no ids, timestamps, or absolute paths).
 */
const REPO_MAP_PRIORITY = 90;

const repoMapModules: PromptModule[] = [
  {
    id: "repo-map-exploration",
    stage: "exploration",
    priority: REPO_MAP_PRIORITY,
    render: (context) => context.repoMap
      ? `${context.repoMap}

USING THE REPOSITORY MAP
- The map above was built from the code before this run. Start from it: it already names the areas, the most used files, and their exports and routes.
- Do not list directories or glob the whole tree to rediscover what the map shows.
- Read files to confirm the facts you will cite and to fill gaps the map cannot show: README, configuration, examples, and user-visible behavior.
- You have at most ${REPO_MAP_EXPLORATION_MAX_STEPS} tool turns. Read several files per turn when you can, and write the summary as soon as the evidence is enough.`
      : undefined,
  },
  {
    id: "repo-map-analysis",
    stage: "analysis",
    priority: REPO_MAP_PRIORITY,
    render: (context) => context.repoMap
      ? `${context.repoMap}

The repository map above was built from the code. Use it to check file paths, export names, and routes in the analysis. When the map and the exploration summary disagree, trust the exploration summary: it comes from reading the files.`
      : undefined,
  },
];

const publicPolicyModules: PromptModule[] = PUBLIC_POLICY_STAGES.map((stage) => ({
  id: `public-documentation-policy-${stage}`,
  stage,
  priority: 1,
  render: (context) => {
    const policy = resolveDocumentationPolicy(resolveDocumentationBrief(context.documentationBrief));
    return `PUBLIC DOCUMENTATION POLICY (${policy.version})
- ${policy.primaryRule}
- ${policy.evidenceRule}
- ${policy.contextRule}
- Infer the public reader from the product: SDK adopter, API consumer, tool user, application operator, or the closest evidence-backed role.
- Internal implementation, private team workflows, diagnostics, tests, and repository-only tooling are not public product documentation.`;
  },
}));

/** Next to the repo map, and as stable: the notes come from the same source tree. */
const AGENT_NOTES_PRIORITY = 92;

const repositoryAgentNotesModules: PromptModule[] = (["exploration", "analysis"] as const).map((stage) => ({
  id: `repository-agent-notes-${stage}`,
  stage,
  priority: AGENT_NOTES_PRIORITY,
  render: (context) => context.repositoryAgentNotes,
}));

/**
 * After the repo map: the instructions are the same for every call of a run,
 * so they stay inside the cached prefix too.
 */
const PROJECT_INSTRUCTIONS_PRIORITY = 95;

const projectInstructionsModules: PromptModule[] = PUBLIC_POLICY_STAGES.map((stage) => ({
  id: `project-instructions-${stage}`,
  stage,
  priority: PROJECT_INSTRUCTIONS_PRIORITY,
  render: (context) => {
    const projectInstructions = context.documentationBrief?.projectInstructions;
    return projectInstructions ? renderProjectInstructionsBlock(projectInstructions) : undefined;
  },
}));

export const promptModules: PromptModule[] = [
  ...publicPolicyModules,
  ...repoMapModules,
  ...repositoryAgentNotesModules,
  ...projectInstructionsModules,
  {
    id: "json-contract",
    stage: "analysis",
    priority: 10,
    render: () => `CRITICAL JSON OUTPUT RULES
- Output only a valid JSON object.
- Do not include markdown code fences, prose, comments, or explanations.
- Start with { and end with }.`,
  },
  {
    id: "analysis-schema",
    stage: "analysis",
    priority: 20,
    render: () => `ANALYSIS JSON SHAPE
{
  "projectName": "string",
  "projectType": "string",
  "projectCategory": "cli | api | web-app | library | platform | mobile-app | desktop-app | framework | monorepo | other",
  "projectProfile": "cli | api | web-app | docs-template | library | platform | framework | monorepo | application | fallback",
  "profileConfidence": 0.0,
  "profileEvidence": ["specific file-backed evidence"],
  "languages": [],
  "frameworks": [],
  "entryPoints": [],
  "keyFiles": [],
  "summary": "string",
  "projectDescription": "string",
  "isMonorepo": false,
  "hasReact": false,
  "hasApiRoutes": false,
  "hasCli": false,
  "packages": [],
  "cliCommands": [],
  "publicInterfaces": {
    "cliCommands": [],
    "apiEndpoints": [],
    "exports": [],
    "routes": []
  },
  "internalTooling": {
    "packageScripts": [],
    "buildTools": []
  },
  "documentationIntent": {
    "audience": "consumer",
    "primaryUseCase": "what a new adopter wants to accomplish",
    "publicPackageNames": [],
    "canonicalWorkflows": [
      {
        "name": "string",
        "framework": "optional string",
        "installCommands": [],
        "requiredFiles": [],
        "canonicalImports": [],
        "envVars": [],
        "routePaths": [],
        "verificationSteps": [],
        "sourceEvidence": []
      }
    ],
    "internalOnlyPaths": [],
    "consumerTerminology": []
  },
  "publicEditorialBrief": {
    "productPositioning": "optional public product positioning",
    "intendedReaders": [],
    "readerGoals": [],
    "focusAreas": [],
    "deprioritizedAreas": [],
    "preferredTone": "optional editorial tone",
    "preferredTerminology": []
  },
  "configFiles": [],
  "apiEndpoints": [],
  "keyFeatures": [],
  "installMethods": [],
  "externalIntegrations": [],
  "documentationCollections": [
    {
      "id": "stable-kebab-case-collection-id",
      "title": "Reader-facing collection title",
      "description": "What this repeated surface covers",
      "kind": "docs | package | manifest | mixed",
      "sourceEvidence": [{ "path": "docs/path", "kind": "docs", "title": "optional label" }],
      "items": [
        {
          "id": "collection-id/item-id",
          "title": "Item Title",
          "slug": "item-slug",
          "description": "What the item covers",
          "packageName": "optional published package",
          "installCommand": "optional install command",
          "sourceEvidence": [{ "path": "docs/path/item.mdx", "kind": "docs" }]
        }
      ]
    }
  ],
  "referenceSurfaces": {
    "rest": {
      "label": "REST API",
      "slug": "rest-api",
      "description": "HTTP/RPC/webhook API endpoints served by the project.",
      "baseUrl": "https://api.example.com/v1",
      "servers": ["https://api.example.com/v1"],
      "playground": { "enabled": true, "reason": "Browser requests are supported by the documented server." },
      "authSchemes": [
        { "scheme": "bearer", "location": "header", "name": "Authorization", "description": "Bearer access token issued by the auth service." }
      ],
      "sourceEvidence": [{ "path": "src/routes/api.ts", "kind": "source" }],
      "groups": [
        {
          "id": "users",
          "title": "Users",
          "description": "User resource endpoints.",
          "sourceEvidence": [{ "path": "src/routes/users.ts", "kind": "source" }],
          "endpoints": [
            {
              "id": "get-users-id",
              "title": "Get user",
              "method": "GET",
              "path": "/users/{id}",
              "description": "Fetch a user by ID.",
              "auth": "Bearer token",
              "requestSchema": "Path parameter: id string",
              "responseSchema": "{ id, email, name }",
              "errors": ["401 Unauthorized", "404 Not Found"],
              "parameters": [{ "name": "id", "in": "path", "type": "string", "required": true, "description": "User ID", "example": "usr_123", "enumValues": [] }],
              "bodyFields": [{ "name": "profile.name", "type": "string", "required": false, "description": "Display name", "example": "Ada" }],
              "bodyContentType": "application/json",
              "responses": [{ "status": 200, "contentType": "application/json", "description": "The matching user", "example": "{\\n  \\"id\\": \\"usr_123\\"\\n}", "fields": [{ "name": "id", "type": "string", "required": true }] }],
              "authRequirement": { "scheme": "bearer", "location": "header", "name": "Authorization", "description": "Bearer access token" },
              "sourceEvidence": [{ "path": "src/routes/users.ts", "kind": "source" }]
            }
          ]
        }
      ]
    },
    "sdk": {
      "label": "API Reference",
      "slug": "api-reference",
      "description": "Public package exports and SDK APIs.",
      "sourceEvidence": [{ "path": "src/index.ts", "kind": "source" }],
      "modules": [
        {
          "id": "client",
          "title": "Client",
          "packageName": "@example/sdk",
          "importPath": "@example/sdk",
          "description": "Primary SDK client exports.",
          "sourceEvidence": [{ "path": "src/client.ts", "kind": "source" }],
          "exports": [
            {
              "id": "create-client",
              "name": "createClient",
              "kind": "function",
              "description": "Create an SDK client.",
              "signature": "createClient(options: ClientOptions): Client",
              "importPath": "@example/sdk",
              "sourceEvidence": [{ "path": "src/client.ts", "kind": "source" }]
            }
          ]
        }
      ]
    }
  }
}`,
  },
  {
    id: "profile-analysis-rules",
    stage: "analysis",
    priority: 30,
    render: (_context, profile) => `PROJECT PROFILE DETECTION
Detected prompt profile to consider: ${profile.label}
${bulletList(profile.analysisRules)}

Classification evidence must be concrete. Prefer README, package metadata, route files, bin entries, source entrypoints, and documented usage over guessed intent.`,
  },
  {
    id: "exploration-role",
    stage: "exploration",
    priority: 10,
    // No job paths here: this prompt is the cached prefix, which other jobs reuse.
    render: (_context, profile) => `You are an expert technical documentation architect performing a deep analysis of a software project.

Your job is to gather concrete, file-backed facts for documentation generation.

Default prompt profile: ${profile.label}

Exploration focus:
${bulletList(profile.explorationFocus)}

General rules:
- Read README and package/build metadata before tracing implementation details.
- Identify what users can do with the project, not only what libraries it uses.
- Separate public interfaces from internal development tooling.
- For open-source libraries/frameworks, treat the default reader as a developer adopting the package in their own app, not a contributor working inside this repository.
- Capture canonical install/config/use workflows from README examples, exported package entrypoints, and example apps; mark repo-only demo/test/dev paths as internal-only evidence.
- Capture REST API and SDK/library API references separately: REST API means every endpoint served by this project; API Reference means public exports consumed from a package/module. Do not mix outbound third-party API clients into REST API.
- Include specific file references and names in your findings.
- Be thorough, but keep findings grounded in the files you inspected.`,
  },
  {
    id: "structure-review-json-contract",
    stage: "structure-review",
    priority: 10,
    render: () => `CRITICAL JSON OUTPUT RULES
- Output only a valid JSON object with a "decisions" array.
- Return exactly one decision for every supplied page ID.
- Use only supplied page IDs and section IDs. Do not invent identifiers.
- Do not include markdown fences, prose, comments, or explanations.`,
  },
  {
    id: "structure-json-contract",
    stage: "structure",
    priority: 10,
    render: () => `CRITICAL JSON OUTPUT RULES
- Output only a valid JSON object with a "sections" array.
- Do not include markdown code fences, prose, comments, or explanations.
- Start with { and end with }.
- Exactly one section MUST have \`"default": true\`. The default section is the one whose pages live at root URLs (/quickstart, /overview, etc.) — typically the main "Documentation" section. Every other section is namespaced under its slug.

Required shape:
{
  "sections": [
    {
      "id": "kebab-case-section-id",
      "title": "Section Title",
      "default": true,
      "pages": [
        {
          "id": "kebab-case-page-id",
          "title": "Page Title",
          "description": "Two or three specific sentences explaining what belongs on this page.",
          "group": "Optional navigation group"
        }
      ]
    }
  ]
}`,
  },
  {
    id: "structure-profile-rules",
    stage: "structure",
    priority: 20,
    render: (_context, profile) => `STRUCTURE RULES FOR ${profile.label.toUpperCase()}
${bulletList(profile.structureRules)}

Every page must have a clear reason to exist. Prefer fewer strong pages over many thin pages.`,
  },
  {
    id: "structure-universal-rules",
    stage: "structure",
    priority: 30,
    render: () => `UNIVERSAL STRUCTURE RULES

SECTION-vs-PAGE RULE (read this twice before you generate sections):
- The FIRST section MUST always be "Documentation" with "default": true. Every user-facing page goes here by default.
- Before adding any second/third top-level section, apply this test: "Would a reader expect this as a SEPARATE TOP-LEVEL NAVIGATION ROOT, distinct from the main docs?" If the answer is no, it MUST be a page inside Documentation.
- A non-Documentation section is justified ONLY when it represents a self-contained reference surface for a different idea than the main docs — for example:
  - "CLI Reference" / "Commands" — when the project exposes a public CLI with multiple commands
  - "API Reference" — when the project serves a public HTTP/RPC API with multiple endpoints
  - "SDK Reference" / "API Reference" — when the project is a library with a documented public API surface
  - "Plugin Reference" / "Hooks Reference" — when the project exposes a documented plugin/extension surface
  - "Development" — when there is substantial contributor-facing material (architecture, internals, contribution workflows)
- Topical buckets are NEVER top-level sections. The following names (and anything semantically similar) MUST be pages inside Documentation, not sections: AI, AI Features, Authoring, Customization, Content, Guides, Tutorials, Getting Started, Configuration, Deployment, Integrations, Features, Overview, Reference (alone), Components, Theming, Setup, Quickstart, Installation, Concepts, Intro, Introduction.
- Multiple sections are allowed when each is a distinct reference surface. Err on the side of FEWER sections — a single rich Documentation section with well-organized pages is usually correct.
- Only Documentation may have "default": true. Every other section must omit "default" or set it to false.

PAGE RULES:
- Target 18-32 pages for substantial projects; use fewer when the project surface is small.
- Repeated user-facing collections with 4+ items must use one normal page per item under a shared navigation group.
- Public REST endpoints and public SDK exports must be represented as separate top-level reference sections when detected. Use "REST API" for served HTTP/RPC/webhook endpoints and "API Reference" for SDK/library/framework exports unless configured labels say otherwise.
- REST API reference: create one page per endpoint. Each page covers exactly one HTTP method and path. The generator adds the section overview page, the authentication page, and one resource page per endpoint group. Do not author those pages yourself.
- SDK reference: keep one page per public module. Cover exports, classes, and members inside that page; never create one page per symbol.
- Only actual module exports belong in the SDK export inventory. Class methods and properties are subordinate members of their owning class, not standalone module exports.
- REST API and API Reference are separate surfaces. Do not combine SDK exports into REST API, and do not put served endpoint pages under API Reference.
- Collection pages must carry item-specific install/config/use details from their source evidence and share the collection title as their navigation group.
- Page titles must describe product capabilities, workflows, references, or concepts.
- Default pages are consumer/adopter docs. Do not create internal maintainer pages such as "Architecture", "Package Map", "E2E Testing", "Internal Tooling", or "Development Setup" unless the user explicitly requested maintainer docs or the page is inside a Development section.
- If an architecture concept helps consumers, title it "How It Works" and explain public runtime concepts, not source-repo organization.
- Titles and nav labels must have balanced punctuation. Avoid code, paths, package import strings, and parenthetical fragments in titles.
- Do not create pages that are only names of internal scripts.
- Do not duplicate the same topic under multiple sections.
- If a topic would produce a thin page, group it into a broader workflow or reference page.
- Descriptions must say what content belongs on the page and which source evidence supports it.`,
  },
  {
    id: "writer-system-base",
    stage: "writer",
    priority: 10,
    render: () => `You are an expert technical documentation writer producing production-quality documentation for software projects.

Write documentation for end users first. Mention implementation details only when the page is explicitly for development, contribution, architecture, or public library API reference.
For reusable libraries/frameworks, the end user is a developer installing and configuring the package in their own project. Do not write as if they are inside this source repository.

OUTPUT FORMAT (STRICT):
- The first character of your response MUST be \`-\` (the first dash of the frontmatter block).
- NEVER wrap your output in an outer \`\`\`markdown ... \`\`\` (or \`\`\`md\`\`\`) code fence.
- NEVER include preambles like "Let me write...", "Here's the documentation...", "I have enough evidence...", "Based on the codebase...", "Now I'll...".
- NEVER include closing remarks like "This completes...", "I hope this helps...", "That covers...".
- Inner code blocks for code examples ARE allowed and required for snippets — every inner \`\`\` opener must have a matching \`\`\` closer, and each opener must include a language identifier.
- Use h2-h4 headings; the page title comes from frontmatter (no h1).
- Do not include Mermaid diagrams.
- Frontmatter may contain only \`title\`, \`description\`, \`keywords\`, and \`icon\`.
- Frontmatter values must be plain text. Do not put URLs, links, route paths, filesystem paths, code spans, markdown, HTML, or unusual symbols in frontmatter.
- Put URLs, routes, filenames, and code references in the page body when they are needed.

INCORRECT (do not do this):
\`\`\`
Here's the architecture page based on my analysis:

\`\`\`markdown
---
title: Architecture
---
## Overview
...
\`\`\`
\`\`\`

CORRECT:
\`\`\`
---
title: "Architecture"
description: "How the system is organized and how the main parts work together."
---

## Overview

Prose paragraph here.
\`\`\``,
  },
  {
    id: "writer-profile-rules",
    stage: "writer",
    priority: 20,
    render: (_context, profile) => `WRITING RULES FOR ${profile.label.toUpperCase()}
${bulletList(profile.writerRules)}`,
  },
  {
    id: "writer-component-directives",
    stage: "writer",
    priority: 25,
    render: () => `COMPONENT USAGE DIRECTIVES

You have access to the MDX components documented in the COMPONENT PLAYBOOK appended to this prompt. Components are not optional decoration — they are required when their pattern fits the content. A page with no component usage is a smell.

When to reach for which component:
- \`<Tabs>\` — whenever you present 2+ alternatives for the same goal: installation methods (npm/pnpm/bun), language variants, OS-specific commands, framework-specific snippets.
- \`<Step>\` + \`<StepItem>\` — for any sequential procedure of 3+ actions (quickstart walkthroughs, configuration setup, deployment steps). Write ONE \`<Step>\` with no props, and one \`<StepItem title="…">\` per step inside it; the step's text and code blocks go inside its \`<StepItem>\`. \`<Step>\` has no \`title\` prop: \`<Step title="…">\` drops the title and numbers every paragraph and code block as a separate step.
- \`<Card>\` — to surface 2-6 navigation links at the end of a section ("What's next", "Related guides", "API reference").
- \`<Note>\` — for callouts: gotchas, deprecations, security caveats, breaking-change notices. Set \`type="warning"\`, \`type="danger"\`, or \`type="info"\` for the visual variant. There is **no** \`<Warning>\`, \`<Tip>\`, \`<Callout>\`, \`<Banner>\`, or \`<Alert>\` component — those will fail to render. Always use \`<Note type="warning">…</Note>\` for warnings.
- \`<FileTree>\` — for any directory-structure illustration of 4+ entries.
- \`<Mermaid>\` — only when the page is explicitly about architecture and a diagram meaningfully clarifies a flow that prose alone cannot.
- \`<ApiEndpoint>\`, \`<ApiRequestExample>\`, \`<ApiResponseExample>\`, \`<ApiParams>\`, and \`<ApiParam>\` are reserved for deterministic REST reference blocks. The generator emits them from analyzed API evidence; writers must not author them by hand.

Hard rules:
- Most pages should use 2-3 components.
- Do NOT invent components. Only the names declared in the playbook below are renderable.
- Do NOT write \`import\` statements for components — the renderer auto-injects them.
- Component props must match the playbook exactly; unknown props will fail to render.
- On REST endpoint pages, write only the source-grounded introduction and usage notes. Authentication, request examples, response examples, and parameter tables are generated deterministically after model validation.

The full component reference, with every prop and a usage example, follows.`,
  },
  {
    id: "writer-quality-contract",
    stage: "writer",
    priority: 30,
    render: () => `QUALITY CONTRACT
- Do not produce skeleton pages, placeholder text, TODOs, empty sections, or heading-only content.
- Every page must contain concrete facts, useful examples, and practical guidance.
- Use tables for options, parameters, config fields, and structured reference data.
- Cross-reference related pages naturally when useful.
- Consumer pages must not expose repo-only paths, demo app credentials, package workspace internals, Playwright/test workflows, or local contributor scripts as setup instructions.
- Use canonical workflows from the project context consistently across pages. Do not invent competing setup patterns for the same framework or package.
- Quickstart and Getting Started pages must choose one canonical workflow, stay under 650 prose words, import every non-global constructor, assign shell variables before use, and end with the source-backed verification result.
- Links to other docs pages must use exact routes from the documentation structure; do not invent /documentation/... links.
- If source evidence is sparse, write a compact but complete page grounded in what is known instead of inventing details.`,
  },
  {
    id: "writer-validation-directive",
    stage: "writer",
    priority: 35,
    render: () => `VALIDATION GATE — \`validate_page\` TOOL

Before you finish, you MUST call the \`validate_page\` tool with the FULL page content (including the \`---\` frontmatter block). The tool returns JSON of the form:
\`{ "ok": true | false, "issues": [{ rule, severity, line?, col?, snippet?, message, hint }] }\`

Rules:
- If \`ok\` is true, emit the same content as your final answer. Do not modify it after the validator passes.
- If \`ok\` is false, fix EVERY issue using the \`hint\` and \`snippet\` fields, then call \`validate_page\` again. Repeat until it returns \`ok: true\`.
- Pay special attention to issues with \`rule: "mdx-parse"\` or \`rule: "end-tag-mismatch"\` — these are hard parser failures (unclosed/mismatched JSX, raw \`<\` in prose, malformed expressions). The page will not render in production until they are gone.
- Do not emit a final page that has not just passed \`validate_page\`. Skipping the gate counts as a failed page.`,
  },
  {
    id: "writer-shared-project-context",
    stage: "writer",
    priority: 40,
    render: (context) =>
      context.includeWriterSharedContext && context.analysis
        ? `PROJECT CONTEXT:
${formatAnalysisSummary(context.analysis)}`
        : "",
  },
  {
    id: "writer-shared-planner-handoff",
    stage: "writer",
    priority: 41,
    render: (context) =>
      context.includeWriterSharedContext
        ? context.writerHandoffSharedContext ?? ""
        : "",
  },
  {
    id: "writer-shared-structure",
    stage: "writer",
    priority: 42,
    render: (context) => {
      if (!context.includeWriterSharedContext) return "";
      const summary = context.structure
        ? formatStructureSummary(context.structure)
        : context.structureSummary;
      return summary
        ? `FULL DOCUMENTATION STRUCTURE:
${summary}`
        : "";
    },
  },
  {
    id: "writer-shared-routes",
    stage: "writer",
    priority: 43,
    render: (context) =>
      context.includeWriterSharedContext && context.routeRegistryContext
        ? `CANONICAL GENERATED ROUTES:
${context.routeRegistryContext}`
        : "",
  },
  {
    id: "writer-shared-editorial-brief",
    stage: "writer",
    priority: 44,
    render: (context) =>
      context.includeWriterSharedContext && context.analysis
        ? `PUBLIC EDITORIAL BRIEF:
${formatPublicEditorialBrief(context.analysis)}`
        : "",
  },
  {
    id: "writer-shared-description-instructions",
    stage: "writer",
    priority: 45,
    render: (context) =>
      context.includeWriterSharedContext
        ? context.descriptionInstructions ?? ""
        : "",
  },
  {
    id: "incremental-analysis-rules",
    stage: "incremental-analysis",
    priority: 10,
    render: () => `You are an expert technical documentation architect performing an incremental update to a project analysis.

Output only a complete valid JSON analysis object. Merge new information with the previous analysis. Do not discard unchanged fields. Remove references to deleted files. Keep public interfaces separate from internal tooling.`,
  },
];
