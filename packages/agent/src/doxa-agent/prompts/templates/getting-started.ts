/**
 * Getting Started Documentation Prompt Template
 * Generates the installation and quick start guide
 */

import type { PromptBuilder, PromptContext } from '../types';

/**
 * Build the getting started documentation prompt
 */
export const gettingStartedPromptBuilder: PromptBuilder = (context: PromptContext): string => {
  const { projectName, languages, answers, packageJson, readme } = context;

  // Determine if it's likely a Node.js project
  const isNodeProject = packageJson && languages.includes('TypeScript') || languages.includes('JavaScript');

  // Determine audience context
  const audienceContext = answers.audience === 'internal'
    ? 'Assume readers have access to internal repositories and tooling.'
    : 'Assume readers are external users starting from scratch.';

  return `Generate a "Getting Started" guide for "${answers.title || projectName}".

## Project Context

- **Title**: ${answers.title || projectName}
- **Description**: ${answers.description || 'Not provided'}
- **Target Audience**: ${answers.audience === 'internal' ? 'Internal team members' : 'External users/developers'}
- **Additional Context**: ${answers.context || 'None provided'}

## Technical Information

- **Languages**: ${languages.join(', ')}
- **Is Node.js Project**: ${isNodeProject ? 'Yes' : 'Unknown'}

${packageJson ? `## Package Configuration\n\n\`\`\`json\n${packageJson}\n\`\`\`\n` : ''}

${readme ? `## Existing README Content (for reference)\n\n${readme.slice(0, 2000)}\n` : ''}

## Requirements

Write a getting started guide that includes:

1. **Prerequisites**
   - Required software and tools (with specific versions if detectable)
   - System requirements
   - Any accounts or access needed

2. **Installation**
   - Step-by-step installation instructions
   - Use actual commands that work (from package.json if available)
   - Include all necessary setup steps

3. **Configuration** (if applicable)
   - Environment variables
   - Configuration files
   - Required settings

4. **Quick Start**
   - Minimal steps to get the project running
   - A simple first example or use case
   - Expected output or result

5. **Verification**
   - How to verify the installation worked
   - Basic commands to test functionality

## Style Guidelines

- ${audienceContext}
- Use numbered steps for sequential actions
- Use code blocks with copy-paste ready commands
- Include expected output where helpful
- Keep it practical and action-oriented
- Length: Focused and efficient, approximately 400-600 words`;
};

export default gettingStartedPromptBuilder;
