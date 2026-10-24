/**
 * Part Prompt Registry
 * Central registry for all section-specific part prompts.
 */

export * from "./types";
export * from "./validators";
export { descriptionPartPrompt } from "./description";

import type { PartPrompt } from "./types";
import { descriptionPartPrompt } from "./description";

const partPromptRegistry = new Map<string, PartPrompt>();
partPromptRegistry.set(descriptionPartPrompt.id, descriptionPartPrompt);

export { partPromptRegistry };

export function getPartPrompt(id: string): PartPrompt | undefined {
  return partPromptRegistry.get(id);
}

export function getPartPromptInstructions(id: string): string {
  const prompt = partPromptRegistry.get(id);
  return prompt?.instructions ?? "";
}
