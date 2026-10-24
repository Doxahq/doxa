/**
 * Provider/Integration Documentation Prompt Template
 * Generates documentation for external service integrations
 */

import type { PromptBuilder, PromptContext } from '../types';

/**
 * Build the provider/integration documentation prompt
 */
export const providerPromptBuilder: PromptBuilder = (context: PromptContext): string => {
  const { projectName, answers } = context;

  return `Generate integration/provider documentation for "${answers.title || projectName}".

## Project Context

- **Title**: ${answers.title || projectName}
- **Description**: ${answers.description || 'Not provided'}
- **Target Audience**: ${answers.audience === 'internal' ? 'Internal team' : 'External users/developers'}

## Requirements

Write a provider/integration setup and usage page that includes:

1. **Overview**
   - What this integration enables (1-2 sentences)
   - Key capabilities when using this provider

2. **Prerequisites**
   - Required accounts or subscriptions
   - API keys or credentials needed
   - Where to obtain credentials (with links if possible)

3. **Setup**
   - Step-by-step installation/configuration
   - Configuration fields specific to this provider
   - Example configuration snippets

4. **Usage Examples**
   - 2-3 real-world usage examples
   - Show the integration in action
   - Include expected output

5. **Configuration Options**
   Provider-specific settings in a table:
   | Option | Type | Default | Description |
   |--------|------|---------|-------------|

6. **Limitations**
   - Known limitations, rate limits, or quotas
   - Unsupported features

7. **Troubleshooting**
   - Common integration errors and solutions
   - How to verify the integration is working

## Formatting Guidelines

- Include provider-specific code blocks
- Use tables for configuration options
- Show complete, working examples
- Reference the provider's official documentation where relevant`;
};

export default providerPromptBuilder;
