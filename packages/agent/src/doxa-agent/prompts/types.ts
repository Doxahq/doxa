/**
 * Prompt System Types
 * Defines interfaces for the modular prompt system
 */

import type { FileInfo } from '../../types';

export type QuestionAnswers = Record<string, unknown>;

/**
 * System prompt definition
 */
export interface SystemPrompt {
  /** Unique identifier */
  id: string;
  /** Role description */
  role: string;
  /** System prompt content */
  content: string;
}

/**
 * Prompt template for generating documentation
 */
export interface PromptTemplate {
  /** Unique identifier */
  id: string;
  /** Template name */
  name: string;
  /** Template description */
  description: string;
  /** Template content with placeholders */
  template: string;
  /** Required variable names */
  variables: string[];
}

/**
 * Context available when building prompts
 */
export interface PromptContext {
  /** Project name */
  projectName: string;
  /** Project root path */
  projectPath: string;
  /** Detected programming languages */
  languages: string[];
  /** Project files (may be limited subset) */
  files: FileInfo[];
  /** Total file count in project */
  totalFiles: number;
  /** User's answers to questions */
  answers: QuestionAnswers;
  /** Package.json content (if available) */
  packageJson?: string;
  /** README content (if available) */
  readme?: string;
}

/**
 * Function type for building prompts from context
 */
export type PromptBuilder = (context: PromptContext) => string;

/**
 * Collection of prompt builders for different doc types
 */
export interface PromptBuilders {
  overview: PromptBuilder;
  gettingStarted: PromptBuilder;
  architecture: PromptBuilder;
  apiReference: PromptBuilder;
  cliReference: PromptBuilder;
  concept: PromptBuilder;
  guide: PromptBuilder;
  configuration: PromptBuilder;
  provider: PromptBuilder;
}
