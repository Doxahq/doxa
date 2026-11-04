import type { ProjectAnalysis } from "../../../types";
import type { ProjectProfile, ProjectProfileId } from "./types";

const USER_FACING_COMMAND_POLICY = [
  "Only document commands that are public product interfaces.",
  "For JavaScript/TypeScript projects, package.json scripts are internal tooling unless package.json exposes a bin entry, README usage documents the command, or source code registers a public command.",
  "Do not create one page per package script such as dev, build, lint, format, typecheck, clean, prepare, deploy, or precommit.",
];

export const projectProfiles: Record<ProjectProfileId, ProjectProfile> = {
  cli: {
    id: "cli",
    label: "CLI",
    categories: ["cli"],
    description: "A command-line product with public commands and options.",
    explorationFocus: [
      "Find package bin entries, executable entrypoints, command parser setup, help text, and README usage examples.",
      "Trace public command handlers enough to understand user-visible behavior, arguments, options, outputs, and failure modes.",
    ],
    analysisRules: [
      "cliCommands must contain only public CLI commands and subcommands.",
      ...USER_FACING_COMMAND_POLICY,
      "If a package script simply runs build, test, lint, or development tooling, place it in internalTooling.packageScripts instead of cliCommands.",
    ],
    structureRules: [
      "User-facing pages (setup, configuration, workflows, troubleshooting, integrations) live inside the Documentation section (default).",
      "A dedicated \"CLI Reference\" (or \"Commands\") top-level section is appropriate ONLY when the project exposes multiple public CLI commands worth a separate navigation root. With a single command, keep it as a page inside Documentation.",
      "Add a Development section only when contributor-facing material (internals, architecture, contribution) is substantial enough to warrant splitting from user docs.",
      "Create CLI reference pages only for confirmed public commands.",
      "If many subcommands exist, group closely related commands instead of producing thin one-command pages.",
    ],
    writerRules: [
      "Show exact commands, flags, arguments, expected output, and troubleshooting.",
      "Write from the perspective of a user running the CLI, not a maintainer reading source code.",
    ],
  },
  api: {
    id: "api",
    label: "API Server",
    categories: ["api"],
    description: "A project that serves HTTP, RPC, webhook, or similar API endpoints.",
    explorationFocus: [
      "Find route definitions, handlers, middleware, auth rules, schemas, error responses, and examples.",
      "Separate served endpoints from client calls to third-party APIs.",
    ],
    analysisRules: [
      "hasApiRoutes is true only when the project defines server-side routes.",
      "apiEndpoints must describe served endpoints, not outbound integrations.",
      "Populate referenceSurfaces.rest with every served endpoint. Do not put SDK exports in REST API.",
      "Put every auth scheme the API accepts in referenceSurfaces.rest.authSchemes. Set endpoint authRequirement to the scheme that endpoint uses. Do not describe auth setup inside endpoint descriptions.",
      "Set referenceSurfaces.rest.baseUrl only from a real server URL found in source, OpenAPI servers, or documented configuration. Never invent one. If the API needs a host the reader must supply, set referenceSurfaces.rest.playground to { \"enabled\": false, \"reason\": \"...\" }.",
      "For each REST endpoint, prefer OpenAPI metadata when available; otherwise use route handlers and validation schemas, and never invent unsupported parameters or fields.",
      "Give every REST endpoint a unique-within-group, 2-to-5-word, imperative, sentence-case title that describes actual behavior. Never include an HTTP method, URL path, path parameter, slash, brace, or colon in the title.",
    ],
    structureRules: [
      "User-facing pages (setup, auth, integrations, workflows) live inside the Documentation section (default).",
      "A dedicated \"API Reference\" top-level section is appropriate when the project exposes multiple public endpoints worth a separate navigation root, with endpoint pages grouped by resource or family inside it. With few endpoints, keep them as pages inside Documentation.",
      "When a REST API section is generated, label it \"REST API\" by default so readers can distinguish it from SDK API Reference.",
      "Add a Development section only when contributor-facing material warrants splitting from user-facing docs.",
      "Include auth, rate limits, request/response models, errors, and common workflows when detected.",
    ],
    writerRules: [
      "Include request shape, response shape, parameters, examples, and common errors.",
      "Do not expose internal handler implementation unless the page is explicitly for contributors.",
    ],
  },
  "web-app": {
    id: "web-app",
    label: "Web App",
    categories: ["web-app", "desktop-app", "mobile-app"],
    description: "A user-facing application with routes, screens, features, configuration, and deployment concerns.",
    explorationFocus: [
      "Find routes, pages, user-facing features, auth/data flows, environment configuration, and deployment targets.",
      "Read README and app configuration before tracing implementation internals.",
    ],
    analysisRules: [
      "keyFeatures should describe user-facing capabilities, not framework features.",
      ...USER_FACING_COMMAND_POLICY,
    ],
    structureRules: [
      "All user-facing pages live in the Documentation section (default). Cover product features, configuration, content/data flows, and deployment as PAGES inside Documentation, not as separate top-level sections.",
      "Add a Development section only when there is a real contributor/maintainer surface to document (architecture, internals, contribution workflows).",
      "Do not create CLI reference pages for package scripts.",
      "Group package scripts into a Development Workflow or Available Scripts page when useful.",
    ],
    writerRules: [
      "Lead with what users or operators can do with the application.",
      "Only discuss framework internals on development or architecture pages.",
    ],
  },
  "docs-template": {
    id: "docs-template",
    label: "Documentation Template",
    categories: ["web-app", "framework", "platform"],
    description: "A documentation site/template where the main product is content, routing, search, AI docs features, customization, and deployment.",
    explorationFocus: [
      "Find content directories, MDX conventions, navigation config, search/indexing, llms.txt, AI chat routes, component customization, and deployment adapters.",
      "Treat package scripts as developer workflows, not public commands.",
    ],
    analysisRules: [
      "keyFeatures should cover documentation-site capabilities such as content sources, navigation, search, MDX components, AI chat, llms.txt, theming, and deployment.",
      "cliCommands should remain empty unless the template exposes a public CLI through a bin entry.",
      ...USER_FACING_COMMAND_POLICY,
    ],
    structureRules: [
      "All user-facing pages live in the Documentation section (default). Cover Getting Started, Content, Customization, AI Features, and Deployment as PAGES inside Documentation, not as separate top-level sections.",
      "Add a Development section only when there is a real contributor surface (architecture, internal APIs, build internals, contribution workflows) that deserves to be split from user-facing docs.",
      "Create pages for real template capabilities, not for package scripts.",
      "Group dev/build/deploy scripts into workflow pages only when they help users run or deploy the template.",
    ],
    writerRules: [
      "Write for someone adopting and customizing the template.",
      "Use examples around content files, navigation, components, search, AI features, and deployment.",
    ],
  },
  library: {
    id: "library",
    label: "Library",
    categories: ["library"],
    description: "A reusable package, SDK, or module consumed by other software.",
    explorationFocus: [
      "Find exported modules, public types, examples, package exports, README usage, and configuration.",
      "Distinguish public API from private implementation files.",
    ],
    analysisRules: [
      "keyFeatures should describe capabilities exposed through the public API.",
      "entryPoints and keyFiles should prioritize exported modules and examples.",
      "Populate referenceSurfaces.sdk for public exports. Do not put served HTTP endpoints in SDK API Reference.",
    ],
    structureRules: [
      "User-facing pages (installation, quickstart, configuration, examples, migration notes) live inside the Documentation section (default).",
      "A dedicated \"API Reference\" or \"SDK Reference\" top-level section is appropriate when the public API surface is large enough to warrant a separate navigation root, with module/class/function pages grouped inside it. With a small surface, keep them as pages inside Documentation.",
      "When an SDK/library reference section is generated, label it \"API Reference\" by default unless configured otherwise.",
      "Add a Development section only when contributor-facing material warrants splitting from public API docs.",
    ],
    writerRules: [
      "Public source code snippets and type signatures are allowed when documenting API usage.",
      "Prefer examples that compile against the public package surface.",
    ],
  },
  platform: {
    id: "platform",
    label: "Platform",
    categories: ["platform"],
    description: "A multi-feature product or platform with several user workflows.",
    explorationFocus: [
      "Find major product surfaces, integrations, configuration, deployment, and operational workflows.",
      "Identify user personas and separate product features from implementation architecture.",
    ],
    analysisRules: [
      "keyFeatures should be grouped around user outcomes and platform capabilities.",
    ],
    structureRules: [
      "All user-facing pages live in the Documentation section (default). Use outcome-oriented feature and guide pages inside Documentation; integrations and deployment belong as PAGES, not separate top-level sections.",
      "Add a Development section only when contributor-facing material warrants splitting from user-facing docs.",
    ],
    writerRules: [
      "Explain capabilities through workflows and examples.",
    ],
  },
  framework: {
    id: "framework",
    label: "Framework",
    categories: ["framework"],
    description: "A framework or template that developers build on top of.",
    explorationFocus: [
      "Find conventions, project structure, extension points, configuration, examples, and generated app behavior.",
    ],
    analysisRules: [
      "Document conventions and extension points separately from internal implementation details.",
      "Populate referenceSurfaces.sdk for public framework APIs, hooks, plugins, or extension points.",
    ],
    structureRules: [
      "User-facing pages (conventions, configuration, components, guides, deployment) live inside the Documentation section (default).",
      "A dedicated \"API Reference\" or \"Plugin Reference\" / \"Hooks Reference\" top-level section is appropriate when the framework exposes a substantial documented extension surface worth a separate navigation root.",
      "Add a Development section only when contributor-facing material (framework internals, contribution workflows) warrants splitting from adopter-facing docs.",
    ],
    writerRules: [
      "Write for developers adopting the framework and extending it safely.",
    ],
  },
  monorepo: {
    id: "monorepo",
    label: "Monorepo",
    categories: ["monorepo"],
    description: "A repository containing multiple packages or applications.",
    explorationFocus: [
      "Find workspaces, package boundaries, public packages, example apps, README usage, and cross-package workflows.",
      "Separate adopter-facing package usage from contributor-facing repository maintenance.",
    ],
    analysisRules: [
      "packages should describe each workspace and its role.",
      "Do not flatten package scripts into public CLI commands.",
      "If the repo contains a public library/framework package, documentationIntent.audience remains consumer and canonicalWorkflows should describe how adopters use the package outside this repository.",
    ],
    structureRules: [
      "All adopter-facing pages live in the Documentation section (default). Prioritize installation, quickstart, public package usage, configuration, examples, integrations, deployment, troubleshooting, and reference pages.",
      "Do not create repository package maps, workspace architecture, E2E testing, or shared tooling pages in default consumer docs.",
      "Add a Development section only when contributor-facing material (cross-package internals, contribution workflows) warrants splitting from user-facing docs.",
    ],
    writerRules: [
      "For consumer pages, translate source-repo examples into instructions for the user's own app.",
      "Mention workspace/package boundaries only on Development or public API reference pages where they directly affect usage.",
    ],
  },
  application: {
    id: "application",
    label: "Application",
    categories: ["desktop-app", "mobile-app", "other"],
    description: "An application that does not fit a more specific profile.",
    explorationFocus: [
      "Find user-facing features, setup, configuration, workflows, and deployment or distribution steps.",
    ],
    analysisRules: [
      "Prefer user-facing features over implementation details.",
      ...USER_FACING_COMMAND_POLICY,
    ],
    structureRules: [
      "All user-facing pages live in the Documentation section (default). Cover Getting Started, Features, Configuration, Guides, and Deployment as PAGES inside Documentation, not as separate top-level sections.",
      "Add a Development section only when contributor-facing material warrants splitting from user-facing docs.",
      "Do not create script-per-page documentation.",
    ],
    writerRules: [
      "Keep pages practical and task-oriented.",
    ],
  },
  fallback: {
    id: "fallback",
    label: "Fallback",
    categories: ["other"],
    description: "A conservative profile used when the project cannot be classified confidently.",
    explorationFocus: [
      "Read README, package metadata, entrypoints, configuration, and representative source files before making assumptions.",
    ],
    analysisRules: [
      "Use projectCategory other when evidence is weak.",
      ...USER_FACING_COMMAND_POLICY,
    ],
    structureRules: [
      "All user-facing pages live in the Documentation section (default). Create a compact set of pages around overview, setup, usage, configuration, and guides inside Documentation.",
      "Add a Development section only when contributor-facing material warrants splitting from user-facing docs.",
      "Avoid specialized CLI/API pages unless evidence is explicit.",
    ],
    writerRules: [
      "Ground every claim in discovered files or obvious project metadata.",
    ],
  },
};

export function detectProjectProfile(analysis?: ProjectAnalysis): ProjectProfile {
  if (!analysis) return projectProfiles.fallback;

  const profileHint = getStringProperty(analysis, "projectProfile");
  if (profileHint && isProjectProfileId(profileHint)) {
    return projectProfiles[profileHint];
  }

  const evidence = [
    analysis.projectName,
    analysis.projectType,
    analysis.summary,
    analysis.projectDescription,
    ...analysis.frameworks,
    ...analysis.keyFeatures,
    ...analysis.entryPoints,
    ...analysis.keyFiles,
  ].join(" ").toLowerCase();

  if (
    evidence.includes("tanstack start") &&
    (evidence.includes("mdx") ||
      evidence.includes("llms.txt") ||
      evidence.includes("docs") ||
      evidence.includes("documentation template") ||
      evidence.includes("search"))
  ) {
    return projectProfiles["docs-template"];
  }

  if (analysis.isMonorepo || analysis.projectCategory === "monorepo") {
    return projectProfiles.monorepo;
  }

  if (analysis.projectCategory === "cli" && analysis.hasCli) {
    return projectProfiles.cli;
  }

  if (analysis.projectCategory === "api" || analysis.hasApiRoutes) {
    return projectProfiles.api;
  }

  if (analysis.projectCategory === "web-app") {
    return projectProfiles["web-app"];
  }

  if (analysis.projectCategory === "library") {
    return projectProfiles.library;
  }

  if (analysis.projectCategory === "framework") {
    return projectProfiles.framework;
  }

  if (analysis.projectCategory === "platform") {
    return projectProfiles.platform;
  }

  if (analysis.projectCategory === "mobile-app" || analysis.projectCategory === "desktop-app") {
    return projectProfiles.application;
  }

  return projectProfiles.fallback;
}

function isProjectProfileId(value: string): value is ProjectProfileId {
  return Object.prototype.hasOwnProperty.call(projectProfiles, value);
}

function getStringProperty(source: ProjectAnalysis, key: string): string | undefined {
  const value = (source as unknown as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}
