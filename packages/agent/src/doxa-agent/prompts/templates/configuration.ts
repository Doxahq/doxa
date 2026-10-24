/**
 * Configuration Reference Documentation Prompt Template
 * Generates configuration documentation with field tables and examples
 */

import type { PromptBuilder, PromptContext } from '../types';

/**
 * Build the configuration reference documentation prompt
 */
export const configurationPromptBuilder: PromptBuilder = (context: PromptContext): string => {
  const { projectName, answers } = context;

  return `Generate configuration reference documentation for "${answers.title || projectName}".

## Project Context

- **Title**: ${answers.title || projectName}
- **Description**: ${answers.description || 'Not provided'}
- **Target Audience**: ${answers.audience === 'internal' ? 'Internal team' : 'External users/developers'}

## Requirements

Write a configuration reference page that includes:

1. **Overview**
   - What this configuration controls
   - Where the config file lives (file path)
   - File format (JSON, YAML, TOML, env, etc.)

2. **Configuration Fields Table**
   Document EVERY configurable field:
   | Field | Type | Default | Required | Description |
   |-------|------|---------|----------|-------------|

3. **Environment Variables** (if applicable)
   | Variable | Default | Description |
   |----------|---------|-------------|

4. **Complete Example**
   - A full, working configuration file with all common options
   - Include inline comments explaining each field

5. **Minimal Example**
   - The smallest valid configuration for getting started

6. **Common Configurations**
   - 2-3 complete examples for typical use cases
   - E.g., "Development", "Production", "Testing"

7. **Validation & Errors**
   - How configuration is validated
   - Common error messages and how to fix them

## Formatting Guidelines

- Use tables for all configuration fields
- Include the file path where config should be placed
- Show complete, copy-paste ready config examples
- Use JSON/YAML code blocks with proper syntax highlighting`;
};

export default configurationPromptBuilder;
