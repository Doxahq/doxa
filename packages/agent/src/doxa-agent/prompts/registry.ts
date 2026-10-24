import { getSystemPrompt } from "./system";
import {
  architecturePromptBuilder,
  apiReferencePromptBuilder,
  cliReferencePromptBuilder,
  conceptPromptBuilder,
  configurationPromptBuilder,
  gettingStartedPromptBuilder,
  guidePromptBuilder,
  overviewPromptBuilder,
  providerPromptBuilder,
} from "./templates";
import type { PromptBuilder, PromptContext } from "./types";
import { descriptionPartPrompt } from "./parts/description";
import type { PartPrompt, PartValidationResult } from "./parts/types";
import { validatePartValue as validatePartPromptValue } from "./parts/validators";
import {
  buildAnalysisPrompt,
  buildExplorationPrompt,
  buildGenericWriterPrompt,
  buildIncrementalAnalysisPrompt,
  buildOrderingPrompt,
  buildStructurePrompt,
  buildStructureReviewPrompt,
  buildWriterPrompt,
} from "./dynamic/builders";
import { composePrompt, type ComposePromptOptions } from "./dynamic/composer";
import { promptModules } from "./dynamic/modules";
import type {
  BuiltPrompt,
  PromptModule,
  PromptRenderContext,
} from "./dynamic/types";

export type PromptTemplateBuilders = Record<string, PromptBuilder>;

export interface PromptRegistryOptions {
  modules?: PromptModule[];
  partPrompts?: PartPrompt[];
  templates?: PromptTemplateBuilders;
}

export interface PromptRegistry {
  composePrompt(options: ComposePromptOptions): BuiltPrompt;
  buildExplorationPrompt(context: PromptRenderContext): BuiltPrompt;
  buildAnalysisPrompt(context: PromptRenderContext): BuiltPrompt;
  buildStructurePrompt(context: PromptRenderContext): BuiltPrompt;
  buildStructureReviewPrompt(context: PromptRenderContext): BuiltPrompt;
  buildWriterPrompt(context: PromptRenderContext): BuiltPrompt;
  buildGenericWriterPrompt(context: PromptRenderContext & {
    title: string;
    description: string;
  }): BuiltPrompt;
  buildIncrementalAnalysisPrompt(context: PromptRenderContext): BuiltPrompt;
  buildOrderingPrompt(context: PromptRenderContext): BuiltPrompt;
  getPartPrompt(id: string): PartPrompt | undefined;
  getPartPromptInstructions(id: string): string;
  validatePartValue(partPrompt: PartPrompt, value: string): PartValidationResult;
  buildTemplatePrompt(
    type: string,
    context: PromptContext,
    componentPlaybook?: string,
  ): { system: string; user: string };
  getDocumentTypes(): string[];
  getFilenameForType(type: string): string;
  getTitleForType(type: string): string;
}

interface DocumentMetadata {
  filename: string;
  title: string;
}

const builtInTemplateBuilders: PromptTemplateBuilders = {
  overview: overviewPromptBuilder,
  gettingStarted: gettingStartedPromptBuilder,
  architecture: architecturePromptBuilder,
  apiReference: apiReferencePromptBuilder,
  cliReference: cliReferencePromptBuilder,
  concept: conceptPromptBuilder,
  guide: guidePromptBuilder,
  configuration: configurationPromptBuilder,
  provider: providerPromptBuilder,
};

const builtInDocumentMetadata: Record<string, DocumentMetadata> = {
  overview: { filename: "overview.mdx", title: "Overview" },
  gettingStarted: { filename: "getting-started.mdx", title: "Getting Started" },
  architecture: { filename: "architecture.mdx", title: "Architecture" },
  apiReference: { filename: "api-reference.mdx", title: "API Reference" },
  cliReference: { filename: "cli-reference.mdx", title: "CLI Reference" },
  concept: { filename: "concept.mdx", title: "Core Concepts" },
  guide: { filename: "guide.mdx", title: "How-To Guides" },
  configuration: { filename: "configuration.mdx", title: "Configuration" },
  provider: { filename: "provider.mdx", title: "Integrations" },
};

export function createPromptRegistry(
  options: PromptRegistryOptions = {},
): PromptRegistry {
  const modules = [...promptModules, ...(options.modules ?? [])];
  const templateBuilders = {
    ...builtInTemplateBuilders,
    ...(options.templates ?? {}),
  };
  const partPromptRegistry = new Map<string, PartPrompt>();

  for (const prompt of [descriptionPartPrompt, ...(options.partPrompts ?? [])]) {
    partPromptRegistry.set(prompt.id, prompt);
  }

  return {
    composePrompt: (composeOptions) => composePrompt({
      ...composeOptions,
      modules: [...modules, ...(composeOptions.modules ?? [])],
    }),
    buildExplorationPrompt: (context) => buildExplorationPrompt(context, modules),
    buildAnalysisPrompt: (context) => buildAnalysisPrompt(context, modules),
    buildStructurePrompt: (context) => buildStructurePrompt(context, modules),
    buildStructureReviewPrompt: (context) => buildStructureReviewPrompt(context, modules),
    buildWriterPrompt: (context) => buildWriterPrompt(context, modules),
    buildGenericWriterPrompt: (context) => buildGenericWriterPrompt(context, modules),
    buildIncrementalAnalysisPrompt: (context) =>
      buildIncrementalAnalysisPrompt(context, modules),
    buildOrderingPrompt: (context) => buildOrderingPrompt(context, modules),
    getPartPrompt: (id) => partPromptRegistry.get(id),
    getPartPromptInstructions: (id) =>
      partPromptRegistry.get(id)?.instructions ?? "",
    validatePartValue: validatePartPromptValue,
    buildTemplatePrompt: (type, context, componentPlaybook) => {
      const builder = templateBuilders[type];
      if (!builder) {
        throw new Error(`Unknown prompt template type: ${type}`);
      }
      return {
        system: getSystemPrompt("documentation", componentPlaybook),
        user: builder(context),
      };
    },
    getDocumentTypes: () => Object.keys(templateBuilders),
    getFilenameForType: (type) =>
      builtInDocumentMetadata[type]?.filename ?? `${slugify(type)}.mdx`,
    getTitleForType: (type) =>
      builtInDocumentMetadata[type]?.title ?? titleize(type),
  };
}

export const defaultPromptRegistry = createPromptRegistry();

export const prompts = defaultPromptRegistry;

function slugify(value: string): string {
  const slug = value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "prompt";
}

function titleize(value: string): string {
  return slugify(value)
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
