/**
 * Part Prompt System — Types
 * Generic interfaces for section-specific prompt constraints and validation.
 */

export interface PartPromptConstraint {
  maxWords?: number;
  minWords?: number;
  maxChars?: number;
  pattern?: RegExp;
  /** Custom validation function — returns null if valid, or a fix string */
  validate?: (value: string) => string | null;
}

export interface PartPrompt {
  id: string;
  /** Which frontmatter field or content section this targets */
  target: string;
  /** Instructions text to inject into the writer prompt */
  instructions: string;
  /** Inline examples for the prompt */
  examples: string[];
  /** Validation constraints applied post-generation */
  constraints: PartPromptConstraint;
  /** Prefix patterns to strip automatically */
  antiPatterns?: RegExp[];
}

export interface PartValidationResult {
  valid: boolean;
  original: string;
  fixed: string;
  issues: string[];
}
