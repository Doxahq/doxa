/**
 * Core Concept Documentation Prompt Template
 * Generates explanatory pages for domain concepts
 */

import type { PromptBuilder, PromptContext } from '../types';

/**
 * Build the concept documentation prompt
 */
export const conceptPromptBuilder: PromptBuilder = (context: PromptContext): string => {
  const { projectName, languages, answers } = context;

  return `Generate a core concept explanation page for "${answers.title || projectName}".

## Project Context

- **Title**: ${answers.title || projectName}
- **Description**: ${answers.description || 'Not provided'}
- **Languages**: ${languages.join(', ')}
- **Target Audience**: ${answers.audience === 'internal' ? 'Internal team' : 'External users/developers'}

## Requirements

Write a concept explanation page that includes:

1. **What is [concept]?**
   - Clear, jargon-free definition in 2-3 sentences
   - Analogy or comparison to familiar concepts if helpful

2. **Why it matters**
   - What problem does this concept solve?
   - What happens without understanding this concept?

3. **How it works**
   - Technical explanation appropriate to the audience
   - Use Mermaid diagrams for flows, lifecycles, or architectures
   - Include data models or schemas if relevant
   - Show the concept's relationship to other parts of the system

4. **Key components**
   - Break down the concept into its constituent parts
   - Explain each part's role and responsibility

5. **Practical example**
   - Show the concept in action with real code from the project
   - Walk through the example step by step
   - Include expected output or behavior

6. **Best practices**
   - Tips for using this concept effectively
   - Common mistakes to avoid

7. **Related concepts**
   - Links to other concept pages that are related

## Style Guidelines

- Start with the "what" before the "how"
- Use progressive disclosure — simple explanation first, details after
- Include visual aids (diagrams, tables) for complex relationships
- Keep code examples focused and minimal`;
};

export default conceptPromptBuilder;
