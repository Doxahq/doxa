/**
 * Prompts Module
 * Central export for all prompt-related functionality
 *
 * This module provides:
 * - System prompts for AI role definition
 * - Prompt templates for different documentation types
 * - Prompt builders that take context and generate final prompts
 *
 * To modify AI behavior, edit the prompts in this agent package:
 * - prompts/system/documentation.ts - System role prompts
 * - prompts/templates/*.ts - Document-specific templates
 *
 * The MDX component reference is loaded dynamically from the template's
 * agent/component-playbook.md at generation time. See TemplateGenerator.
 */

export * from './types';
export * from './system';
export * from './templates';
export * from './parts';
export * from './dynamic';
export * from './registry';

import type { PromptBuilders, PromptContext } from './types';
import { prompts } from './registry';

/**
 * All prompt builders organized by document type
 */
export const promptBuilders: PromptBuilders = {
  overview: (context) => prompts.buildTemplatePrompt('overview', context).user,
  gettingStarted: (context) => prompts.buildTemplatePrompt('gettingStarted', context).user,
  architecture: (context) => prompts.buildTemplatePrompt('architecture', context).user,
  apiReference: (context) => prompts.buildTemplatePrompt('apiReference', context).user,
  cliReference: (context) => prompts.buildTemplatePrompt('cliReference', context).user,
  concept: (context) => prompts.buildTemplatePrompt('concept', context).user,
  guide: (context) => prompts.buildTemplatePrompt('guide', context).user,
  configuration: (context) => prompts.buildTemplatePrompt('configuration', context).user,
  provider: (context) => prompts.buildTemplatePrompt('provider', context).user,
};

/**
 * Build a complete prompt for a document type.
 * Combines system prompt with template prompt.
 * Pass componentPlaybook to inject the template's component reference dynamically.
 */
export function buildPrompt(
  type: keyof PromptBuilders,
  context: PromptContext,
  componentPlaybook?: string
): { system: string; user: string } {
  return prompts.buildTemplatePrompt(type, context, componentPlaybook);
}

/**
 * Get all available document types
 */
export function getDocumentTypes(): Array<keyof PromptBuilders> {
  return prompts.getDocumentTypes() as Array<keyof PromptBuilders>;
}

/**
 * Map document type to filename
 */
export function getFilenameForType(type: keyof PromptBuilders): string {
  return prompts.getFilenameForType(type);
}

/**
 * Map document type to title
 */
export function getTitleForType(type: keyof PromptBuilders): string {
  return prompts.getTitleForType(type);
}
