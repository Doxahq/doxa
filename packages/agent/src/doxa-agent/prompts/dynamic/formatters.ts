import type { DocumentationStructure, ProjectAnalysis } from "../../../types";
import { normalizeProjectAnalysis } from "../../../utils/analysis-normalizer";

export function formatAnswers(answers: Record<string, unknown>): string {
  const entries = Object.entries(answers);
  if (entries.length === 0) return "- None provided";
  return entries.map(([key, value]) => `- ${key}: ${JSON.stringify(value)}`).join("\n");
}

export function formatAnalysisSummary(analysis: ProjectAnalysis): string {
  const normalized = normalizeProjectAnalysis(analysis);
  const profile = getOptionalString(normalized, "projectProfile");
  const confidence = getOptionalNumber(normalized, "profileConfidence");

  return [
    `- Project Name: ${normalized.projectName}`,
    `- Project Type: ${normalized.projectType}`,
    `- Project Category: ${normalized.projectCategory}`,
    profile ? `- Project Profile: ${profile}` : undefined,
    typeof confidence === "number" ? `- Profile Confidence: ${confidence}` : undefined,
    `- Languages: ${normalized.languages.join(", ") || "None detected"}`,
    `- Frameworks: ${normalized.frameworks.join(", ") || "None detected"}`,
    `- Summary: ${normalized.summary}`,
    `- Project Description: ${normalized.projectDescription || normalized.summary}`,
    `- Entry Points: ${normalized.entryPoints.join(", ") || "None detected"}`,
    `- Key Files: ${normalized.keyFiles.join(", ") || "None detected"}`,
    `- Install Methods: ${normalized.installMethods.join(", ") || "None detected"}`,
    `- Documentation Audience: ${normalized.documentationIntent?.audience ?? "consumer"}`,
    normalized.documentationIntent?.primaryUseCase
      ? `- Primary Reader Use Case: ${normalized.documentationIntent.primaryUseCase}`
      : undefined,
    normalized.documentationIntent?.publicPackageNames.length
      ? `- Public Packages: ${normalized.documentationIntent.publicPackageNames.join(", ")}`
      : undefined,
    `- Has CLI: ${normalized.hasCli}`,
    `- Has API Routes: ${normalized.hasApiRoutes}`,
    `- Is Monorepo: ${normalized.isMonorepo}`,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

export function formatPublicEditorialBrief(analysis: ProjectAnalysis): string {
  const brief = normalizeProjectAnalysis(analysis).publicEditorialBrief;
  if (!brief) return "- None provided";

  return [
    brief.productPositioning ? `- Product positioning: ${brief.productPositioning}` : undefined,
    brief.intendedReaders.length ? `- Intended readers: ${brief.intendedReaders.join(", ")}` : undefined,
    brief.readerGoals.length ? `- Reader goals: ${brief.readerGoals.join(" | ")}` : undefined,
    brief.focusAreas.length ? `- Focus areas: ${brief.focusAreas.join(", ")}` : undefined,
    brief.deprioritizedAreas.length ? `- Deprioritize: ${brief.deprioritizedAreas.join(", ")}` : undefined,
    brief.preferredTone ? `- Preferred tone: ${brief.preferredTone}` : undefined,
    brief.preferredTerminology.length
      ? `- Preferred terminology: ${brief.preferredTerminology.join(", ")}`
      : undefined,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

export function formatDetectedSurfaces(analysis: ProjectAnalysis): string {
  const normalized = normalizeProjectAnalysis(analysis);
  const sections: string[] = [];

  if (normalized.cliCommands.length > 0) {
    sections.push(`PUBLIC CLI COMMANDS:
${normalized.cliCommands.map((command) => {
  const parts = [
    `- ${command.name}: ${command.description}`,
    command.args?.length ? `  Args: ${command.args.join(", ")}` : undefined,
    command.options?.length ? `  Options: ${command.options.join(", ")}` : undefined,
    command.example ? `  Example: ${command.example}` : undefined,
  ].filter((line): line is string => Boolean(line));
  return parts.join("\n");
}).join("\n")}`);
  }

  if (normalized.configFiles.length > 0) {
    sections.push(`CONFIGURATION FILES:
${normalized.configFiles.map((config) => `- ${config.path}: ${config.description}${config.schema ? ` | Schema: ${config.schema}` : ""}`).join("\n")}`);
  }

  if (normalized.apiEndpoints.length > 0) {
    sections.push(
      `API ENDPOINTS: ${normalized.apiEndpoints.length} public endpoint candidates detected. ` +
      "Use the grouped REST reference surface below for page planning.",
    );
  }

  if (normalized.referenceSurfaces?.rest?.groups.length) {
    sections.push(`REST API REFERENCE SURFACE:
${normalized.referenceSurfaces.rest.groups.map((group) =>
  `- ${group.title}: ${group.endpoints.length} endpoints; plan one page per endpoint and use the resource group only as a navigation heading`
).join("\n")}`);
  }

  if (normalized.referenceSurfaces?.sdk?.modules.length) {
    sections.push(`SDK API REFERENCE SURFACE:
${normalized.referenceSurfaces.sdk.modules.map((module) => [
  `- ${module.title}: ${module.exports.length} exports; plan one module page`,
  module.packageName ? `  Package: ${module.packageName}` : undefined,
  module.importPath ? `  Import: ${module.importPath}` : undefined,
].filter((line): line is string => Boolean(line)).join("\n")).join("\n")}`);
  }

  if (normalized.keyFeatures.length > 0) {
    sections.push(`KEY FEATURES:
${normalized.keyFeatures.map((feature) => `- ${feature}`).join("\n")}`);
  }

  if (normalized.externalIntegrations.length > 0) {
    sections.push(`EXTERNAL INTEGRATIONS:
${normalized.externalIntegrations.map((integration) => `- ${integration}`).join("\n")}`);
  }

  if (normalized.documentationCollections?.length) {
    sections.push(`DOCUMENTATION COLLECTIONS (a page about a collection or one of its items uses the collection id below as its collectionId, never another value):
${normalized.documentationCollections.map((collection) => [
  `- ${collection.title} [collectionId: ${collection.id}] (${collection.items.length} items)`,
  collection.description ? `  Description: ${collection.description}` : undefined,
  `  Items: ${collection.items.map((item) => item.title).join(", ")}`,
].filter((line): line is string => Boolean(line)).join("\n")).join("\n")}`);
  }

  const intent = normalized.documentationIntent;
  if (intent?.canonicalWorkflows.length) {
    sections.push(`CANONICAL USER WORKFLOWS:
${intent.canonicalWorkflows.map((workflow) => {
  const lines = [
    `- ${workflow.name}${workflow.framework ? ` (${workflow.framework})` : ""}`,
    workflow.installCommands.length ? `  Install: ${workflow.installCommands.join(" | ")}` : undefined,
    workflow.requiredFiles.length ? `  Files: ${workflow.requiredFiles.join(", ")}` : undefined,
    workflow.canonicalImports.length ? `  Imports: ${workflow.canonicalImports.join(", ")}` : undefined,
    workflow.envVars.length ? `  Env vars: ${workflow.envVars.join(", ")}` : undefined,
    workflow.routePaths.length ? `  Routes: ${workflow.routePaths.join(", ")}` : undefined,
    workflow.verificationSteps.length ? `  Verify: ${workflow.verificationSteps.join(" | ")}` : undefined,
  ].filter((line): line is string => Boolean(line));
  return lines.join("\n");
}).join("\n")}`);
  }

  if (intent?.internalOnlyPaths.length) {
    sections.push(`INTERNAL-ONLY PATHS (evidence only; do not present as consumer setup):
${intent.internalOnlyPaths.map((path) => `- ${path}`).join("\n")}`);
  }

  const internalTooling = getRecordProperty(normalized, "internalTooling");
  const packageScripts = Array.isArray(internalTooling?.packageScripts)
    ? internalTooling.packageScripts.filter((script): script is string => typeof script === "string")
    : [];
  if (packageScripts.length > 0) {
    sections.push(`INTERNAL PACKAGE SCRIPTS:
${packageScripts.map((script) => `- ${script}`).join("\n")}`);
  }

  return sections.join("\n\n");
}

/**
 * Extract a short, prompt-friendly head-of-doc preview: strips frontmatter,
 * MDX import/export lines, and collapses whitespace before truncating to
 * `max` chars on a word boundary. Used by the ordering pass to judge intent
 * without paying for full doc bodies.
 */
export function formatDocHead(content: string, max = 300): string {
  if (!content) return "";

  let body = content;

  // Strip all leading YAML frontmatter blocks (the writer occasionally
  // produces more than one — defensive).
  while (true) {
    const match = body.match(/^---\s*\n[\s\S]*?\n---\s*\n?/);
    if (!match) break;
    body = body.slice(match[0].length);
  }

  // Drop MDX import/export lines.
  body = body
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith("import ") && !trimmed.startsWith("export ");
    })
    .join("\n");

  // Collapse whitespace.
  body = body.replace(/\s+/g, " ").trim();

  if (body.length <= max) return body;

  const truncated = body.slice(0, max);
  const lastSpace = truncated.lastIndexOf(" ");
  return `${lastSpace > max * 0.6 ? truncated.slice(0, lastSpace) : truncated}…`;
}

export function formatStructureSummary(structure: DocumentationStructure): string {
  return structure.sections.map((section) =>
    `### ${section.title}\n${section.pages.map((page) =>
      `- ${page.title}${page.group ? ` [${page.group}]` : ""}: ${page.description}`
    ).join("\n")}`
  ).join("\n\n");
}

function getOptionalString(source: ProjectAnalysis, key: string): string | undefined {
  const value = (source as unknown as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function getOptionalNumber(source: ProjectAnalysis, key: string): number | undefined {
  const value = (source as unknown as Record<string, unknown>)[key];
  return typeof value === "number" ? value : undefined;
}

function getRecordProperty(source: ProjectAnalysis, key: string): Record<string, unknown> | undefined {
  const value = (source as unknown as Record<string, unknown>)[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
