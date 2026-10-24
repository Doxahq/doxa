import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { run, readOnlyTools, validatePageTool } from "../core";
import type {
  AgentSpanCallback,
  AgentUsageCallback,
  Provider,
  TrackedTools,
} from "../core";
import type {
  DocPage,
  DocumentationStructure,
  ProjectAnalysis,
  RestApiReferenceGroup,
  RestApiReferenceSurface,
  WriterContext,
  WriterDiagnosticCallback,
  WriterExplorationMode,
  WriterRepairDiagnosticCallback,
  WriterValidationConfig,
} from "../types";
import { DEFAULT_WRITER_VALIDATION } from "../types";
import { sanitizeValue } from "../utils/frontmatter";
import { normalizeProjectAnalysis } from "../utils/analysis-normalizer";
import { runPageValidation } from "../utils/page-validator";
import { runWriterAttempts } from "./writer-pipeline";
import type { ValidationHistoryEntry } from "../utils/retry-hint";
import {
  DEFAULT_WRITER_MAX_STEPS,
  VALIDATION_ONLY_WRITER_MAX_STEPS,
  WRITER_LENGTH_RETRY_MAX_TOKENS,
  WRITER_MAX_SINGLE_TOOL_OUTPUT_CHARS,
  WRITER_MAX_TOKENS,
  WRITER_MAX_TOOL_OUTPUT_CHARS,
} from "./constants";
import { slugify } from "./structure-utils";
import {
  buildRouteRegistry,
  routeRegistrySummary,
} from "./route-registry";
import { descriptionPartPrompt } from "./prompts/parts";
import { prompts } from "./prompts";
import type { PromptRegistry, PromptRenderContext } from "./prompts";
import { WRITER_FINALIZATION_PROMPT } from "./prompts/system";
import { COMPONENT_PLAYBOOK } from "./prompts/component-playbook.generated";
import {
  formatWriterHandoffPageForPrompt,
  formatWriterHandoffSharedForPrompt,
} from "./writer-handoff";
import {
  repairMdxWithModel,
  TARGETED_MDX_REPAIR_MAX_ATTEMPTS,
} from "./mdx-repair-model";
import {
  appendRestEndpointReferenceBlock,
  assertRestEndpointPageRenders,
  isRestEndpointPage,
  renderRestEndpointReferenceBlock,
  resolveRestEndpoint,
  restEndpointReferenceOptions,
  restFrontmatterMetadata,
} from "./rest-endpoint-page";
import { resolveProjectPath } from "../core/tools/project-path";
import {
  buildPageEvidenceBundle,
  buildSourceEvidenceContext,
  type PageEvidenceBundle,
} from "./evidence-bundle";
export { buildSourceEvidenceContext } from "./evidence-bundle";

export type PageType =
  | "cli-reference"
  | "concept"
  | "guide"
  | "configuration"
  | "provider"
  | "getting-started"
  | "overview"
  | "api-reference"
  | "rest-api-reference"
  | "rest-api-overview"
  | "rest-api-auth"
  | "rest-api-group"
  | "sdk-api-reference"
  | "architecture"
  | "general";

export function detectPageType(sectionTitle: string, pageTitle: string, page?: DocPage): PageType {
  const reference = page?.reference;
  if (reference?.kind === "rest") {
    if (reference.pageKind === "overview") return "rest-api-overview";
    if (reference.pageKind === "auth") return "rest-api-auth";
    if (reference.pageKind === "group") return "rest-api-group";
    return "rest-api-reference";
  }
  if (reference?.kind === "sdk") return "sdk-api-reference";

  const sLower = sectionTitle.toLowerCase();
  const pLower = pageTitle.toLowerCase();

  if (sLower.includes("cli reference") || sLower.includes("cli commands") || sLower.includes("command reference")) return "cli-reference";
  if (sLower.includes("guide") || sLower.includes("how-to") || sLower.includes("tutorial")) return "guide";
  if (sLower.includes("concept") || sLower.includes("core concept")) return "concept";
  if (sLower.includes("configuration") || sLower.includes("config") || pLower.includes("configuration") || pLower.includes("environment variable")) return "configuration";
  if (sLower.includes("integration") || sLower.includes("provider")) return "provider";
  if (sLower.includes("getting started") || pLower.includes("installation") || pLower.includes("quickstart") || pLower.includes("quick start")) return "getting-started";
  if (pLower.includes("overview") || pLower.includes("introduction")) return "overview";
  if (sLower.includes("rest api") || sLower.includes("endpoint")) return "rest-api-reference";
  if (sLower.includes("api reference") || sLower.includes("api documentation") || sLower.includes("sdk reference")) return "sdk-api-reference";
  if (pLower.includes("architecture") || pLower.includes("design") || sLower.includes("development")) return "architecture";
  return "general";
}

function shouldPreserveFrontmatterTitle(
  page: DocPage,
): boolean {
  return isRestEndpointPage(page);
}

async function appendDeterministicRestReference(
  content: string,
  page: DocPage,
  writerContext: WriterContext | undefined,
  onSpan?: AgentSpanCallback,
): Promise<string> {
  const resolved = resolveRestEndpoint(page, writerContext?.analysis);
  if (!resolved) return content;

  const block = renderRestEndpointReferenceBlock(
    resolved.endpoint,
    resolved.surface,
    restEndpointReferenceOptions(writerContext),
  );
  const composed = appendRestEndpointReferenceBlock(content, block);

  await assertRestEndpointPageRenders(composed, resolved.endpoint.id, onSpan);

  return composed;
}

/**
 * The frontmatter description every writer path stores: sanitized, then
 * normalized by the project's description part prompt.
 */
export function composePageDescription(
  promptRegistry: PromptRegistry,
  description: string,
): string {
  const descriptionPart = promptRegistry.getPartPrompt("description") ?? descriptionPartPrompt;
  return promptRegistry.validatePartValue(descriptionPart, sanitizeValue(description)).fixed;
}

function getPageTypeInstructions(pageType: PageType): string {
  const instructions: Record<PageType, string> = {
    "cli-reference": `## CLI Reference Page Instructions
Write a user-friendly CLI command reference page. Remember: show the command from the USER's perspective.
1. **What it does**: 1-2 sentences explaining the purpose and when you'd use this command
2. **Usage**: Show the command syntax with arguments and options as the user would type them in their terminal
3. **Options Table**: Available flags and options in a clean table (Option | Description | Default)
4. **Examples**: 3-5 practical examples showing real use cases with expected output. Frame each example as a task: "Deploy to production", "Check status of all instances"
5. **Related Commands**: Brief mentions of related commands

Component nudges: use \`<Tabs>\` when the same command differs by OS or runtime; use \`<Card>\` to link to related commands at the bottom; use \`<Note>\` for non-obvious flag interactions.

Do NOT show internal source code. Show only what the user types and sees.`,

    "guide": `## How-To Guide Instructions
Write a practical, task-oriented guide. The reader wants to accomplish something specific.
1. **Introduction**: One sentence — what you'll accomplish by the end of this guide
2. **Prerequisites**: What you need before starting (keep it brief, link to installation if needed)
3. **Steps**: Numbered steps. Each step should have:
   - A clear action-oriented title on its \`<StepItem title="…">\` ("Configure your cloud provider", not "Step 3")
   - The exact command or action to take
   - What you should see after (expected output)
4. **Verify it worked**: One quick check to confirm success
5. **Troubleshooting**: 2-3 common issues with solutions
6. **Next Steps**: What to do next (with links to relevant pages)

Component nudges: render the numbered procedure with one \`<Step>\` holding a \`<StepItem title="…">\` per step; use \`<Tabs>\` when a step has package-manager or platform variants; close with \`<Card>\` links for Next Steps.`,

    "concept": `## Core Concept Page Instructions
Write a clear explanation of this concept for end users. No internal implementation details.
1. **What is [concept]?**: 2-3 sentence definition that a non-expert can understand
2. **Why it matters**: What problem does this solve for the user? Why should they care?
3. **How it works**: Explain from the USER's perspective — what they see, what happens when they use it. Use a simple numbered flow, NOT internal code or architecture diagrams
4. **Key features**: Break down into user-facing capabilities with bold labels and short descriptions
5. **Example**: Show the concept in action using CLI commands or configuration — NOT internal source code
6. **Best practices**: Practical tips for getting the most out of this feature

Component nudges: render "How it works" with one \`<Step>\` holding a \`<StepItem title="…">\` per step; use \`<Card>\` to link to related concept pages; use \`<Note>\` for best-practice callouts.`,

    "configuration": `## Configuration Reference Page Instructions
Write a practical configuration reference. Focus on what the user needs to set up and configure.
1. **Overview**: What this configuration controls and where the config file lives
2. **Options Table**: Document every user-configurable field (Field | Type | Default | Description)
3. **Environment Variables**: List env vars the user can set, with descriptions
4. **Example Configuration**: A complete, copy-paste ready config file with inline comments
5. **Common setups**: 2-3 example configurations for typical use cases (e.g., "Minimal setup", "Production setup")

Component nudges: use \`<Tabs>\` to show env-var vs config-file variants of the same setting; use \`<Note>\` for deprecation warnings and \`<Note type="warning">\` for footguns.`,

    "provider": `## Integration/Provider Page Instructions
Write a practical integration guide focused on getting the user set up.
1. **Overview**: One sentence — what this integration enables for the user
2. **Prerequisites**: What accounts, API keys, or setup you need before starting
3. **Setup**: Numbered steps to configure the integration, with exact commands and config snippets
4. **Configuration Options**: Provider-specific settings in a simple table
5. **Usage**: Show a real example of using this integration end-to-end
6. **Limitations**: Any known limits, quotas, or caveats
7. **Troubleshooting**: Common issues and quick fixes

Component nudges: render setup with one \`<Step>\` holding a \`<StepItem title="…">\` per step; use \`<Tabs>\` when SDKs differ by language; use \`<Note type="warning">\` for credentials handling and \`<Note>\` for free-tier limits.`,

    "getting-started": `## Getting Started Page Instructions
Write one compact, source-grounded path that gets the reader to a verified result. The reader wants to get up and running FAST.
1. **Prerequisites**: List required software with minimum versions. Keep it to what's strictly necessary
2. **Installation**: Use the install command from one canonical workflow in project context. Do not combine unrelated self-hosted, REST, SDK, or contributor setup paths
3. **Quick Start**: The absolute minimum steps to see it working (aim for under 5 minutes)
4. **What you should see**: Show the expected output or result so the reader knows they succeeded
5. **Next Steps**: 2-3 links to the most useful next pages, each with a one-line description of what they'll learn

Hard contract:
- Keep prose under 650 words. Prefer one successful workflow over an exhaustive setup guide
- Every install command, import, environment variable, route, and verification step must come from the canonical workflow or source evidence
- Import every non-global constructor used in JavaScript or TypeScript examples
- Assign shell variables before using them; never leave placeholders such as \`$BASE_URL\` undefined
- Make commands copy-paste coherent: each step must build on values and resources created earlier on this page

Component nudges: wrap installation methods in \`<Tabs>\` (one tab per package manager / platform); render Quick Start with one \`<Step>\` holding a \`<StepItem title="…">\` per step; close with \`<Card>\` links for Next Steps.`,

    "overview": `## Overview/Introduction Page Instructions
Write an engaging introduction that immediately communicates value. This is the first page most users will read.
1. **What is [project]?**: 2-3 sentences — what it does and who it's for. No internal tech stack mentions
2. **Key Features**: Bulleted list where each item has a **bold label** and a short benefit-oriented description. Frame as what the user GETS, not how it's built
3. **How it works**: A simple 3-5 step numbered flow showing the user journey from start to finish. Describe what the USER does at each step, not what the code does internally
4. **Supported platforms / providers / integrations**: If applicable, list what's supported in a clean table or bullet list with brief descriptions
5. **Next Steps**: Direct links to Installation and Quickstart with one-line descriptions

Component nudges: surface Key Features as a \`<Card>\` grid (each Card title = feature label, body = benefit); render "How it works" with one \`<Step>\` holding a \`<StepItem title="…">\` per step; close with \`<Card>\` links to Installation and Quickstart.`,

    "api-reference": `## API Reference Page Instructions
Write clear, practical API documentation. Focus on how to USE the API.
1. **Overview**: What this endpoint/function does in one sentence
2. **Usage**: Show the exact syntax, request format, or function signature
3. **Parameters**: Clean table (Name | Type | Required | Description)
4. **Response**: Show what the user gets back, with an example response
5. **Examples**: 2-3 practical examples with expected output
6. **Errors**: Common error responses and what they mean
7. **Related**: Links to related endpoints/functions

Component nudges: use \`<Tabs>\` when the same call has multiple language SDKs (curl / JS / Python); use \`<Card>\` for the Related section; use \`<Note type="warning">\` for breaking-change notices.`,

    "rest-api-reference": `## REST API Reference Page Instructions

The renderer already shows the following, generated from analyzed API evidence.
Do NOT write any of it:
- The HTTP method and path. A bar at the top of the page shows them.
- A request example, curl or otherwise. A request card shows it.
- A response example or status codes. A response card shows them.
- Authentication instructions, headers, tokens, or scopes.
- Parameter tables for path, query, header, body, or response fields.

Write ONLY this, in this order:
1. Two to four sentences on what this endpoint does and when a caller uses it.
2. Behavior the tables cannot show: side effects, idempotency, ordering,
   pagination limits, rate limits, or retry rules. Include this only when the
   source evidence shows it.
3. Nothing else. A short page is correct. Do not pad it.

Do NOT use \`##\` headings named Endpoint, Request, Response, Authentication,
Authorization, Parameters, Body, Errors, or Examples. Those sections exist
already and a second copy is a defect.`,

    "rest-api-overview": `## REST API Overview Page Instructions
Write the section overview with these sections, in this order:
1. **Overview**: Explain what the public API provides and who calls it.
2. **Base URL**: Show only a source-evidenced base URL or server URL.
3. **Authentication**: When the canonical route list contains a generated authentication page, give two short sentences and link to it. Otherwise state only the verified authentication status and do not invent a link. Do not repeat the full auth setup.
4. **Resources**: Add a table that lists every endpoint with its method, path, resource, and source-grounded description.

Do not invent a server URL, credential flow, endpoint, parameter, or response.`,

    "rest-api-auth": `## REST API Authentication Page Instructions
This is the only page that contains full authentication guidance.
Document each source-evidenced auth scheme, how a caller obtains a credential, how the caller sends it, and the unauthenticated response.
If the evidence does not show credential issuance or unauthenticated behavior, state only the verified facts. Do not invent setup steps, token scopes, or status codes.`,

    "rest-api-group": `## REST API Resource Page Instructions
Write the resource overview with these sections, in this order:
1. **Overview**: Explain the resource and the operations in this group.
2. **Schema**: Add one field table from the source-evidenced request and response fields. Show field, type, required state, and description.
3. **Endpoints**: Add a table with method, path, and description for every endpoint in this group. Link each endpoint through the canonical route list when a route exists.

Do not add request examples, response examples, or authentication setup to this page.`,

    "sdk-api-reference": `## SDK API Reference Page Instructions
Write dense, scannable SDK/library API reference documentation for public exports. This is not REST endpoint documentation.
1. **Import**: Show the canonical import path and package name when known.
2. **Signature**: Show the function/class/type/component signature in a TypeScript code block when available.
3. **Parameters or props**: Use tables for arguments, options, props, or type fields.
4. **Return value**: Describe the return type and important behavior.
5. **Examples**: Include practical, compiling examples against the public package surface.
6. **Errors and edge cases**: Document thrown errors, rejected promises, null states, or unsupported inputs when known.
7. **Related APIs**: Link to related exports in the API Reference section.

Component nudges: use \`<Tabs>\` for TypeScript/JavaScript or framework variants; use \`<Note>\` for version or runtime constraints; use \`<Card>\` for related APIs.`,

    "architecture": `## Architecture/Development Page Instructions
Only write repository architecture and contribution details when this page is in a Development section or explicitly targets maintainers. Otherwise, rewrite the topic as a consumer-facing "How it works" explanation focused on runtime concepts, configuration flow, and public extension points.
1. **Overview**: High-level description of how the system is organized
2. **Directory Structure**: Purpose of each major directory
3. **Key Components**: Core modules and their responsibilities
4. **Data Flow**: How data moves through the system (use a numbered list, not code)
5. **Development Setup**: How to clone, install, and run locally for development
6. **Contributing**: Guidelines for submitting changes

Component nudges: render the directory layout with \`<FileTree>\`; use \`<Card>\` to link to related architecture pages; render the development-setup steps with one \`<Step>\` holding a \`<StepItem title="…">\` per step.

Every heading must have explanatory prose before any child heading. Do not end with a large component-only block; close with a complete sentence or a properly closed component/code block.`,

    "general": `Write clear, user-focused documentation for this topic. Lead with what it does for the user. Include practical examples showing CLI commands and expected output — not internal source code. Keep paragraphs short and use tables and bullet points for scannability.`,
  };
  return instructions[pageType];
}

function getRelevantContext(
  pageTitle: string,
  sectionTitle: string,
  pageType: PageType,
  analysis: ProjectAnalysis,
  structure?: DocumentationStructure,
  page?: DocPage,
): string {
  const normalized = normalizeProjectAnalysis(analysis);
  const parts: string[] = [];
  const pageTitleLower = pageTitle.toLowerCase();
  const intent = normalized.documentationIntent;
  const pageAudience = page?.audience ?? intent?.audience ?? "consumer";
  parts.push(`DOCUMENTATION INTENT:
- Audience: ${pageAudience}
- Primary use case: ${intent?.primaryUseCase || "Help a new adopter use the project successfully."}
- Public packages: ${intent?.publicPackageNames.join(", ") || "None detected"}
- Consumer rule: write for the reader's own project, not this source repository.`);

  if (intent?.canonicalWorkflows.length) {
    parts.push(`CANONICAL WORKFLOWS TO USE CONSISTENTLY:
${intent.canonicalWorkflows.map((workflow) => {
  const rows = [
    `- ${workflow.name}${workflow.framework ? ` (${workflow.framework})` : ""}`,
    workflow.installCommands.length ? `  Install commands: ${workflow.installCommands.join(" | ")}` : undefined,
    workflow.requiredFiles.length ? `  Required files: ${workflow.requiredFiles.join(", ")}` : undefined,
    workflow.canonicalImports.length ? `  Canonical imports: ${workflow.canonicalImports.join(", ")}` : undefined,
    workflow.envVars.length ? `  Environment variables: ${workflow.envVars.join(", ")}` : undefined,
    workflow.routePaths.length ? `  Routes/endpoints: ${workflow.routePaths.join(", ")}` : undefined,
    workflow.verificationSteps.length ? `  Verification: ${workflow.verificationSteps.join(" | ")}` : undefined,
  ].filter((row): row is string => Boolean(row));
  return rows.join("\n");
}).join("\n")}`);
  }

  if (intent?.internalOnlyPaths.length) {
    parts.push(`INTERNAL-ONLY EVIDENCE (do not present as consumer setup):
${intent.internalOnlyPaths.map((path) => `- ${path}`).join("\n")}`);
  }

  if (structure) {
    parts.push(`AVAILABLE DOC ROUTES:
${routeRegistrySummary(buildRouteRegistry(structure))}`);
  }

  if (pageType === "cli-reference" && normalized.cliCommands.length > 0) {
    const matchingCmd = normalized.cliCommands.find(cmd =>
      pageTitleLower.includes(cmd.name.toLowerCase()) ||
      cmd.name.toLowerCase().includes(pageTitleLower.replace(/\s+/g, "-"))
    );
    if (matchingCmd) {
      parts.push(`RELEVANT CLI COMMAND DATA:
- Command: ${matchingCmd.name}
- Description: ${matchingCmd.description}
${matchingCmd.args?.length ? `- Arguments: ${matchingCmd.args.join(", ")}` : ""}
${matchingCmd.options?.length ? `- Options: ${matchingCmd.options.join(", ")}` : ""}
${matchingCmd.example ? `- Example: ${matchingCmd.example}` : ""}`);
    }
  }

  if (pageType === "configuration" && normalized.configFiles.length > 0) {
    const relevantConfigs = normalized.configFiles.filter(cf =>
      pageTitleLower.includes(cf.path.toLowerCase().split("/").pop()?.replace(/\.[^.]+$/, "") || "") ||
      cf.description.toLowerCase().includes(pageTitleLower)
    );
    if (relevantConfigs.length > 0) {
      parts.push(`RELEVANT CONFIG FILES:\n${relevantConfigs.map(cf =>
        `- ${cf.path}: ${cf.description}${cf.schema ? `\n  Schema: ${cf.schema}` : ""}`
      ).join("\n")}`);
    } else {
      parts.push(`ALL CONFIG FILES:\n${normalized.configFiles.map(cf =>
        `- ${cf.path}: ${cf.description}`
      ).join("\n")}`);
    }
  }

  if (pageType === "provider" && normalized.externalIntegrations.length > 0) {
    const match = normalized.externalIntegrations.find(i =>
      pageTitleLower.includes(i.toLowerCase()) || i.toLowerCase().includes(pageTitleLower)
    );
    if (match) parts.push(`RELEVANT INTEGRATION: ${match}`);
  }

  if (pageType === "api-reference" && normalized.apiEndpoints.length > 0) {
    parts.push(`API ENDPOINTS:\n${boundedLines(normalized.apiEndpoints.map(ep =>
      endpointLine("- ", ep.method, ep.path, ep.description)
    )).join("\n")}`);
  }

  const reference = page?.reference;
  const restSurface = normalized.referenceSurfaces?.rest;
  if (pageType === "rest-api-overview" && restSurface) {
    parts.push(formatRestOverviewContext(restSurface));
  }
  if (pageType === "rest-api-auth" && restSurface) {
    parts.push(formatRestAuthContext(restSurface));
  }
  if (pageType === "rest-api-group" && restSurface && reference?.kind === "rest") {
    const group = restSurface.groups.find(
      (candidate) => candidate.id === reference.groupId,
    );
    if (group) parts.push(formatRestGroupContext(group));
  }
  if (pageType === "rest-api-reference" && reference?.kind === "rest") {
    const group = restSurface?.groups.find((candidate) => candidate.id === reference.groupId);
    const endpoint = group?.endpoints.find((candidate) => candidate.id === reference.endpointId);
    const lines = [
      "REST API REFERENCE TARGET:",
      group ? `- Resource group: ${group.title}` : undefined,
      group && !reference.endpointId
        ? `- Cover every endpoint in this group:\n${group.endpoints.map((item) =>
          `  - ${item.method} ${item.path}: ${item.description}` +
          `${item.auth ? ` | Auth: ${item.auth}` : ""}` +
          `${item.requestSchema ? ` | Request: ${item.requestSchema}` : ""}` +
          `${item.responseSchema ? ` | Response: ${item.responseSchema}` : ""}` +
          `${item.errors?.length ? ` | Errors: ${item.errors.join(", ")}` : ""}`
        ).join("\n")}`
        : undefined,
      endpoint ? `- Endpoint: ${endpoint.method} ${endpoint.path}` : undefined,
      endpoint?.description ? `- Description: ${endpoint.description}` : undefined,
      endpoint?.auth ? `- Auth: ${endpoint.auth}` : undefined,
      endpoint?.requestSchema ? `- Request schema: ${endpoint.requestSchema}` : undefined,
      endpoint?.responseSchema ? `- Response schema: ${endpoint.responseSchema}` : undefined,
      endpoint?.errors?.length ? `- Errors: ${endpoint.errors.join(" | ")}` : undefined,
    ].filter((line): line is string => Boolean(line));
    parts.push(lines.join("\n"));
  }

  if (pageType === "sdk-api-reference" && reference?.kind === "sdk") {
    const sdk = normalized.referenceSurfaces?.sdk;
    const module = sdk?.modules.find((candidate) => candidate.id === reference.moduleId);
    const sdkExport = module?.exports.find((candidate) => candidate.id === reference.exportId);
    const lines = [
      "SDK API REFERENCE TARGET:",
      module ? `- Module: ${module.title}` : undefined,
      module?.packageName ? `- Package: ${module.packageName}` : undefined,
      module?.importPath ? `- Module import path: ${module.importPath}` : undefined,
      module && !reference.exportId
        ? `- Cover every public export in this module. Treat dotted names as members of their owning class, never as separate module exports:\n${module.exports.map((item) =>
          `  - ${item.name} (${item.kind}): ${item.description}` +
          `${item.signature ? ` | Signature: ${item.signature}` : ""}` +
          `${item.importPath ? ` | Import: ${item.importPath}` : ""}`
        ).join("\n")}`
        : undefined,
      sdkExport ? `- Export: ${sdkExport.name} (${sdkExport.kind})` : undefined,
      sdkExport?.description ? `- Description: ${sdkExport.description}` : undefined,
      sdkExport?.signature ? `- Signature: ${sdkExport.signature}` : undefined,
      sdkExport?.importPath ? `- Export import path: ${sdkExport.importPath}` : undefined,
    ].filter((line): line is string => Boolean(line));
    parts.push(lines.join("\n"));
  }

  if (normalized.keyFeatures.length > 0) {
    parts.push(`KEY FEATURES: ${normalized.keyFeatures.join(", ")}`);
  }

  if (pageType === "getting-started" && normalized.installMethods.length > 0) {
    parts.push(`INSTALL METHODS:\n${normalized.installMethods.map(m => `- ${m}`).join("\n")}`);
  }

  return parts.join("\n\n");
}

function formatRestOverviewContext(surface: RestApiReferenceSurface): string {
  const serverUrls = [surface.baseUrl, ...(surface.servers ?? [])]
    .filter((value): value is string => Boolean(value?.trim()));
  return quotedRepositoryData("REST API OVERVIEW DATA:", [
    surface.description ? `- Description: ${surface.description}` : undefined,
    serverUrls.length > 0
      ? `- Verified server URLs: ${Array.from(new Set(serverUrls)).join(", ")}`
      : "- Verified server URLs: none found",
    surface.authSchemes?.length
      ? `- Auth schemes: ${surface.authSchemes.map(formatRestAuthScheme).join(" | ")}`
      : "- Auth schemes: none found",
    "- Resource and endpoint inventory:",
    ...boundedLines(surface.groups.flatMap((group) => [
      `  - ${oneLine(`${group.title} (${group.endpoints.length} endpoints)${group.description ? `: ${group.description}` : ""}`)}`,
      ...group.endpoints.map((endpoint) =>
        endpointLine("    - ", endpoint.method, endpoint.path, endpoint.description)
      ),
    ])),
  ]);
}

function formatRestAuthContext(surface: RestApiReferenceSurface): string {
  return quotedRepositoryData("REST API AUTHENTICATION DATA:", surface.authSchemes?.length
    ? surface.authSchemes.map((auth) => `- ${formatRestAuthScheme(auth)}`)
    : ["- No shared auth scheme was found in analysis."]);
}

function formatRestAuthScheme(
  auth: NonNullable<RestApiReferenceSurface["authSchemes"]>[number],
): string {
  return [
    auth.scheme,
    auth.location ? `location=${auth.location}` : undefined,
    auth.name ? `name=${auth.name}` : undefined,
    auth.description,
  ].filter((value): value is string => Boolean(value)).join("; ");
}

function formatRestGroupContext(group: RestApiReferenceGroup): string {
  return quotedRepositoryData("REST API RESOURCE DATA:", [
    `- Resource: ${group.title}`,
    group.description ? `- Description: ${group.description}` : undefined,
    "- Endpoints:",
    ...boundedLines(group.endpoints.flatMap((endpoint) => [
      endpointLine("  - ", endpoint.method, endpoint.path, endpoint.description),
      ...(endpoint.bodyFields?.map((field) =>
        `    - ${oneLine(`Request field ${field.name}: ${field.type}; required=${field.required}; ${field.description ?? "No source description."}`)}`
      ) ?? []),
      ...(endpoint.responses?.flatMap((response) =>
        response.fields?.map((field) =>
          `    - ${oneLine(`Response ${response.status} field ${field.name}: ${field.type}; required=${field.required}; ${field.description ?? "No source description."}`)}`
        ) ?? []
      ) ?? []),
    ])),
  ]);
}

const REPOSITORY_DATA_CLOSE = "</repository_data>";

/**
 * API data from the repository, inside a quoted block: a spec or a route
 * handler can hold text that looks like an instruction, and the writer reads
 * it as data. A closing tag inside the data is removed, so the data cannot
 * end the block early.
 */
function quotedRepositoryData(heading: string, lines: readonly (string | undefined)[]): string {
  return [
    heading,
    "<repository_data>",
    ...lines
      .filter((line): line is string => Boolean(line))
      .map((line) => line.replaceAll(REPOSITORY_DATA_CLOSE, "")),
    REPOSITORY_DATA_CLOSE,
  ].join("\n");
}

/**
 * The most characters of API inventory in one writer prompt. Without a page
 * cap, an API can have thousands of endpoints; the rest shows as a count.
 */
const MAX_API_INVENTORY_CHARS = 24_000;
/** The longest line of API inventory; a long description is cut. */
const MAX_INVENTORY_LINE_CHARS = 240;

function endpointLine(prefix: string, method: string, path: string, description: string): string {
  return `${prefix}${oneLine(`${method} ${path}: ${description}`)}`;
}

/** One line of at most 240 characters, with whitespace collapsed. */
function oneLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= MAX_INVENTORY_LINE_CHARS ? line : `${line.slice(0, MAX_INVENTORY_LINE_CHARS - 1)}…`;
}

/** The lines that fit the inventory budget, then one line that counts the rest. */
function boundedLines(lines: readonly string[]): string[] {
  const kept: string[] = [];
  let used = 0;
  for (const [index, line] of lines.entries()) {
    if (used + line.length + 1 > MAX_API_INVENTORY_CHARS) {
      kept.push(`  - (${lines.length - index} more lines of the API inventory are left out.)`);
      break;
    }
    kept.push(line);
    used += line.length + 1;
  }
  return kept;
}

function buildStructureSummary(structure: DocumentationStructure): string {
  return structure.sections.map(section =>
    `### ${section.title}\n${section.pages.map(page =>
      `- ${page.title}: ${page.description}`
    ).join("\n")}`
  ).join("\n\n");
}

export async function saveWriterDebugAttempt(
  artifactRoot: string,
  title: string,
  attempt: number,
  rawContent: string,
  reason: string
): Promise<string> {
  const debugDir = await resolveProjectPath(
    artifactRoot,
    join(".doxa", "dev-debug", "pages", slugify(title) || "untitled"),
  );
  await mkdir(debugDir, { recursive: true });
  const debugPath = await resolveProjectPath(
    debugDir,
    `attempt-${attempt}.md`,
  );
  const debugContent = [
    `<!-- reason: ${reason.replace(/-->/g, "-- >")} -->`,
    "",
    rawContent,
  ].join("\n");
  await writeFile(debugPath, debugContent, "utf-8");
  return debugPath;
}

export async function writeDocPage(
  provider: Provider,
  cwd: string,
  sectionTitle: string,
  pageId: string,
  page: DocPage,
  writerContext?: WriterContext,
  componentPlaybook: string = COMPONENT_PLAYBOOK,
  writerValidation: WriterValidationConfig = DEFAULT_WRITER_VALIDATION,
  promptRegistry: PromptRegistry = prompts,
  abortController?: AbortController,
  initialRetryHint?: string,
  initialValidationHistory?: readonly ValidationHistoryEntry[],
  pageRetry = 0,
  artifactRoot: string = cwd,
  onDiagnostic?: WriterDiagnosticCallback,
  onUsage?: AgentUsageCallback,
  onRepairDiagnostic?: WriterRepairDiagnosticCallback,
  onSpan?: AgentSpanCallback,
  writerExploration: WriterExplorationMode = "agentic",
  evidenceBundle?: PageEvidenceBundle,
  modelCallTimeoutMs?: number,
  modelCallMaxDurationMs?: number,
  writerMaxSteps: number = DEFAULT_WRITER_MAX_STEPS,
): Promise<string> {
  const title = page.title;
  const description = page.description;
  const preserveTitle = shouldPreserveFrontmatterTitle(page);
  const restEndpointPage = isRestEndpointPage(page);
  const restFrontmatter = restFrontmatterMetadata(page);
  const pageType = detectPageType(sectionTitle, title, page);
  const pageTypeInstructions = getPageTypeInstructions(pageType);
  const descriptionInstructions = promptRegistry.getPartPromptInstructions("description");
  const resolvedEvidenceBundle = await resolveEvidenceBundle({
    cwd,
    pageId,
    page,
    writerContext,
    writerExploration,
    evidenceBundle,
  });
  const sourceEvidenceContext = resolvedEvidenceBundle?.context ??
    await buildSourceEvidenceContext(cwd, page);
  const validationOnly = writerExploration === "evidence_first" &&
    resolvedEvidenceBundle?.sufficient === true;
  const writerExplorationMode: PromptRenderContext["writerExplorationMode"] =
    validationOnly ? "validation_only" : "agentic";
  const routeRegistryContext = writerContext?.structure
    ? routeRegistrySummary(buildRouteRegistry(writerContext.structure))
    : undefined;
  const writerHandoffSharedContext = writerContext?.writerHandoff
    ? formatWriterHandoffSharedForPrompt(writerContext.writerHandoff)
    : undefined;
  const writerHandoffPageContext = writerContext?.writerHandoff
    ? formatWriterHandoffPageForPrompt(
        writerContext.writerHandoff,
        pageId,
      )
    : undefined;
  const writerPromptContext = writerContext
    ? {
        analysis: writerContext.analysis,
        answers: writerContext.answers,
        structure: writerContext.structure,
        sectionTitle,
        page,
        pageType,
        pageTypeInstructions,
        descriptionInstructions,
        relevantContext: getRelevantContext(title, sectionTitle, pageType, writerContext.analysis, writerContext.structure, page),
        sourceEvidenceContext,
        routeRegistryContext,
        writerHandoffSharedContext,
        writerHandoffPageContext,
        seedPageText: writerContext.seedPages?.[pageId],
        previousPage: writerContext.previousPages?.[pageId],
        writerExplorationMode,
        componentPlaybook,
        documentationBrief: writerContext.documentationBrief,
      }
    : undefined;

  const result = await runWriterAttempts({
    pageId,
    title,
    description,
    preserveTitle,
    ...restFrontmatter,
    maxAttempts: writerValidation.maxAttempts,
    targetedRepairClasses: writerValidation.targetedRepairClasses,
    validation: {
      mdxCompile: writerValidation.mdxCompile,
      timeoutMs: writerValidation.timeoutMs,
      restEndpointPage,
      onSpan,
    },
    baseTokens: WRITER_MAX_TOKENS,
    expandedTokens: WRITER_LENGTH_RETRY_MAX_TOKENS,
    initialRetryHint,
    initialValidationHistory,
    pageRetry,
    runOnce: async ({ retryHint, maxTokens, attempt, pageRetry }) => {
      const writerPrompt = writerPromptContext
        ? promptRegistry.buildWriterPrompt({ ...writerPromptContext, retryHint })
        : promptRegistry.buildGenericWriterPrompt({
            title,
            description,
            descriptionInstructions,
            pageTypeInstructions,
            writerExplorationMode,
            componentPlaybook,
            retryHint,
          });
      const runResult = await run(
        {
          provider,
          systemPrompt: writerPrompt.system,
          tools: validationOnly
            ? [validatePageTool({
              mdxCompile: writerValidation.mdxCompile,
              timeoutMs: writerValidation.timeoutMs,
              preserveTitle,
              restEndpointPage,
              onSpan,
            })]
            : [
              ...readOnlyTools(cwd),
              validatePageTool({
                mdxCompile: writerValidation.mdxCompile,
                timeoutMs: writerValidation.timeoutMs,
                preserveTitle,
                restEndpointPage,
                onSpan,
              }),
            ],
          maxSteps: validationOnly
            ? VALIDATION_ONLY_WRITER_MAX_STEPS
            : writerMaxSteps,
          loopPolicy: {
            finalizationPrompt: WRITER_FINALIZATION_PROMPT,
            repeatedToolCallLimit: 3,
          },
          maxTokens,
          modelCallTimeoutMs,
          modelCallMaxDurationMs,
          maxToolOutputChars: WRITER_MAX_TOOL_OUTPUT_CHARS,
          maxSingleToolOutputChars: WRITER_MAX_SINGLE_TOOL_OUTPUT_CHARS,
          abortController,
          usageContext: {
            operation: "page_write",
            pageId,
            pageTitle: title,
            pageRetry,
            attempt,
          },
          onUsage,
          onSpan,
        },
        writerPrompt.user,
      );
      return {
        text: runResult.text,
        finishReason: runResult.finishReason,
        loop: runResult.loop,
      };
    },
    saveDebug: (attempt, rawContent, reason) =>
      saveWriterDebugAttempt(artifactRoot, title, attempt, rawContent, reason),
    onWarn: (message) => console.warn(message),
    onDiagnostic,
    onRepairDiagnostic,
    repairMdx: async ({
      draft,
      issue,
      repairClass,
      pageRetry,
      writerAttempt,
    }) =>
      repairMdxWithModel({
        provider,
        draft,
        issue: {
          rule: issue.rule,
          message: issue.message,
          line: issue.line,
          column: issue.col,
        },
        repairClass,
        pageId,
        pageTitle: title,
        pageRetry,
        writerAttempt,
        abortController,
        modelCallTimeoutMs,
        modelCallMaxDurationMs,
        onUsage,
        onSpan,
        maxAttempts: TARGETED_MDX_REPAIR_MAX_ATTEMPTS,
        validate: (content) => validateRepairedPage(
          content,
          writerValidation,
          onSpan,
          preserveTitle,
          restEndpointPage,
        ),
      }),
    composeDescription: (agentDescription) =>
      composePageDescription(promptRegistry, agentDescription || description),
  });

  return appendDeterministicRestReference(
    result.content,
    page,
    writerContext,
    onSpan,
  );
}

export async function writeDocPageTracked(
  provider: Provider,
  cwd: string,
  sectionTitle: string,
  pageId: string,
  page: DocPage,
  writerContext: WriterContext | undefined,
  trackedTools: TrackedTools,
  componentPlaybook: string = COMPONENT_PLAYBOOK,
  writerValidation: WriterValidationConfig = DEFAULT_WRITER_VALIDATION,
  promptRegistry: PromptRegistry = prompts,
  abortController?: AbortController,
  initialRetryHint?: string,
  initialValidationHistory?: readonly ValidationHistoryEntry[],
  pageRetry = 0,
  artifactRoot: string = cwd,
  onDiagnostic?: WriterDiagnosticCallback,
  onUsage?: AgentUsageCallback,
  onRepairDiagnostic?: WriterRepairDiagnosticCallback,
  onSpan?: AgentSpanCallback,
  writerExploration: WriterExplorationMode = "agentic",
  evidenceBundle?: PageEvidenceBundle,
  modelCallTimeoutMs?: number,
  modelCallMaxDurationMs?: number,
  writerMaxSteps: number = DEFAULT_WRITER_MAX_STEPS,
): Promise<string> {
  const title = page.title;
  const description = page.description;
  const preserveTitle = shouldPreserveFrontmatterTitle(page);
  const restEndpointPage = isRestEndpointPage(page);
  const restFrontmatter = restFrontmatterMetadata(page);
  const pageType = detectPageType(sectionTitle, title, page);
  const pageTypeInstructions = getPageTypeInstructions(pageType);
  const descriptionInstructions = promptRegistry.getPartPromptInstructions("description");
  const resolvedEvidenceBundle = await resolveEvidenceBundle({
    cwd,
    pageId,
    page,
    writerContext,
    writerExploration,
    evidenceBundle,
  });
  const sourceEvidenceContext = resolvedEvidenceBundle?.context ??
    await buildSourceEvidenceContext(cwd, page);
  const validationOnly = writerExploration === "evidence_first" &&
    resolvedEvidenceBundle?.sufficient === true;
  const writerExplorationMode: PromptRenderContext["writerExplorationMode"] =
    validationOnly ? "validation_only" : "agentic";
  const routeRegistryContext = writerContext?.structure
    ? routeRegistrySummary(buildRouteRegistry(writerContext.structure))
    : undefined;
  const writerHandoffSharedContext = writerContext?.writerHandoff
    ? formatWriterHandoffSharedForPrompt(writerContext.writerHandoff)
    : undefined;
  const writerHandoffPageContext = writerContext?.writerHandoff
    ? formatWriterHandoffPageForPrompt(
        writerContext.writerHandoff,
        pageId,
      )
    : undefined;
  const writerPromptContext = writerContext
    ? {
        analysis: writerContext.analysis,
        answers: writerContext.answers,
        structure: writerContext.structure,
        sectionTitle,
        page,
        pageType,
        pageTypeInstructions,
        descriptionInstructions,
        relevantContext: getRelevantContext(title, sectionTitle, pageType, writerContext.analysis, writerContext.structure, page),
        sourceEvidenceContext,
        routeRegistryContext,
        writerHandoffSharedContext,
        writerHandoffPageContext,
        seedPageText: writerContext.seedPages?.[pageId],
        previousPage: writerContext.previousPages?.[pageId],
        writerExplorationMode,
        componentPlaybook,
        documentationBrief: writerContext.documentationBrief,
      }
    : undefined;

  const result = await runWriterAttempts({
    pageId,
    title,
    description,
    preserveTitle,
    ...restFrontmatter,
    maxAttempts: writerValidation.maxAttempts,
    targetedRepairClasses: writerValidation.targetedRepairClasses,
    validation: {
      mdxCompile: writerValidation.mdxCompile,
      timeoutMs: writerValidation.timeoutMs,
      restEndpointPage,
      onSpan,
    },
    baseTokens: WRITER_MAX_TOKENS,
    expandedTokens: WRITER_LENGTH_RETRY_MAX_TOKENS,
    initialRetryHint,
    initialValidationHistory,
    pageRetry,
    runOnce: async ({ retryHint, maxTokens, attempt, pageRetry }) => {
      const writerPrompt = writerPromptContext
        ? promptRegistry.buildWriterPrompt({ ...writerPromptContext, retryHint })
        : promptRegistry.buildGenericWriterPrompt({
            title,
            description,
            descriptionInstructions,
            pageTypeInstructions,
            writerExplorationMode,
            componentPlaybook,
            retryHint,
          });
      const runResult = await run(
        {
          provider,
          systemPrompt: writerPrompt.system,
          tools: validationOnly
            ? [validatePageTool({
              mdxCompile: writerValidation.mdxCompile,
              timeoutMs: writerValidation.timeoutMs,
              preserveTitle,
              restEndpointPage,
              onSpan,
            })]
            : [
              ...trackedTools.tools,
              validatePageTool({
                mdxCompile: writerValidation.mdxCompile,
                timeoutMs: writerValidation.timeoutMs,
                preserveTitle,
                restEndpointPage,
                onSpan,
              }),
            ],
          maxSteps: validationOnly
            ? VALIDATION_ONLY_WRITER_MAX_STEPS
            : writerMaxSteps,
          loopPolicy: {
            finalizationPrompt: WRITER_FINALIZATION_PROMPT,
            repeatedToolCallLimit: 3,
          },
          maxTokens,
          modelCallTimeoutMs,
          modelCallMaxDurationMs,
          maxToolOutputChars: WRITER_MAX_TOOL_OUTPUT_CHARS,
          maxSingleToolOutputChars: WRITER_MAX_SINGLE_TOOL_OUTPUT_CHARS,
          abortController,
          usageContext: {
            operation: "page_write",
            pageId,
            pageTitle: title,
            pageRetry,
            attempt,
          },
          onUsage,
          onSpan,
        },
        writerPrompt.user,
      );
      return {
        text: runResult.text,
        finishReason: runResult.finishReason,
        loop: runResult.loop,
      };
    },
    saveDebug: (attempt, rawContent, reason) =>
      saveWriterDebugAttempt(artifactRoot, title, attempt, rawContent, reason),
    onWarn: (message) => console.warn(message),
    onDiagnostic,
    onRepairDiagnostic,
    repairMdx: async ({
      draft,
      issue,
      repairClass,
      pageRetry,
      writerAttempt,
    }) =>
      repairMdxWithModel({
        provider,
        draft,
        issue: {
          rule: issue.rule,
          message: issue.message,
          line: issue.line,
          column: issue.col,
        },
        repairClass,
        pageId,
        pageTitle: title,
        pageRetry,
        writerAttempt,
        abortController,
        modelCallTimeoutMs,
        modelCallMaxDurationMs,
        onUsage,
        onSpan,
        maxAttempts: TARGETED_MDX_REPAIR_MAX_ATTEMPTS,
        validate: (content) => validateRepairedPage(
          content,
          writerValidation,
          onSpan,
          preserveTitle,
          restEndpointPage,
        ),
      }),
    composeDescription: (agentDescription) =>
      composePageDescription(promptRegistry, agentDescription || description),
  });

  return appendDeterministicRestReference(
    result.content,
    page,
    writerContext,
    onSpan,
  );
}

/** The forced final turn needs at least one turn before it. */
const MIN_WRITER_MAX_STEPS = 2;

/**
 * The model-turn cap of one agentic writer attempt, the forced final turn
 * included. A validation-only writer keeps its own fixed cap.
 */
export function resolveWriterMaxSteps(value: number | undefined): number {
  const resolved = value ?? DEFAULT_WRITER_MAX_STEPS;
  if (!Number.isInteger(resolved) || resolved < MIN_WRITER_MAX_STEPS) {
    throw new RangeError(
      `writerMaxSteps must be an integer of at least ${MIN_WRITER_MAX_STEPS}.`,
    );
  }
  return resolved;
}

async function resolveEvidenceBundle(input: {
  cwd: string;
  pageId: string;
  page: DocPage;
  writerContext?: WriterContext;
  writerExploration: WriterExplorationMode;
  evidenceBundle?: PageEvidenceBundle;
}): Promise<PageEvidenceBundle | undefined> {
  if (input.writerExploration !== "evidence_first") {
    return undefined;
  }
  if (input.evidenceBundle) {
    return input.evidenceBundle;
  }
  if (!input.writerContext) {
    return undefined;
  }
  return buildPageEvidenceBundle({
    cwd: input.cwd,
    pageId: input.pageId,
    page: input.page,
    analysis: input.writerContext.analysis,
    handoffBrief: input.writerContext.writerHandoff?.pages.find(
      (brief) => brief.pageId === input.pageId,
    ),
  });
}

async function validateRepairedPage(
  content: string,
  writerValidation: WriterValidationConfig,
  onSpan?: AgentSpanCallback,
  preserveTitle = false,
  restEndpointPage = false,
): Promise<{ ok: boolean; issueCodes: string[] }> {
  const report = await runPageValidation(content, {
    mdxCompile: writerValidation.mdxCompile,
    timeoutMs: writerValidation.timeoutMs,
    preserveTitle,
    restEndpointPage,
    onSpan,
  });
  return {
    ok: report.ok && report.issues.length === 0,
    issueCodes: report.issues.map((issue) => issue.rule),
  };
}
