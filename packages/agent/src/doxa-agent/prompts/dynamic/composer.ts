import { promptModules } from "./modules";
import { detectProjectProfile } from "./profiles";
import type { BuiltPrompt, PromptModule, PromptRenderContext, PromptStage } from "./types";

export interface ComposePromptOptions {
  stage: PromptStage;
  context: PromptRenderContext;
  systemIntro?: string;
  userBody: string;
  modules?: PromptModule[];
}

export function composePrompt(options: ComposePromptOptions): BuiltPrompt {
  const profile = detectProjectProfile(options.context.analysis);
  const modules = [...(options.modules ?? promptModules)]
    .filter((module) => module.stage === options.stage)
    .filter((module) => !module.profiles || module.profiles.includes(profile.id))
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));

  const renderedModules = modules
    .map((module) => module.render(options.context, profile))
    .filter((section): section is string => Boolean(section && section.trim().length > 0));

  const systemSections = [
    options.systemIntro?.trim(),
    ...renderedModules.map((section) => section.trim()),
    options.context.componentPlaybook?.trim(),
  ].filter((section): section is string => Boolean(section && section.length > 0));

  return {
    system: systemSections.join("\n\n"),
    user: options.userBody.trim(),
    profile,
  };
}
