/**
 * How-To Guide Documentation Prompt Template
 * Generates task-oriented step-by-step guides
 */

import type { PromptBuilder, PromptContext } from '../types';

/**
 * Build the guide documentation prompt
 */
export const guidePromptBuilder: PromptBuilder = (context: PromptContext): string => {
  const { projectName, answers } = context;

  const audienceContext = answers.audience === 'internal'
    ? 'Assume readers have access to internal tools and repositories.'
    : 'Assume readers are external users starting with a fresh installation.';

  return `Generate a how-to guide for "${answers.title || projectName}".

## Project Context

- **Title**: ${answers.title || projectName}
- **Description**: ${answers.description || 'Not provided'}
- **Target Audience**: ${answers.audience === 'internal' ? 'Internal team' : 'External users/developers'}

## Requirements

Write a task-oriented step-by-step guide that includes:

1. **Introduction** (1 paragraph)
   - What task this guide accomplishes
   - Who should follow this guide
   - Estimated time to complete

2. **Prerequisites**
   - Bulleted list of what's needed before starting
   - Required software versions
   - Required access or credentials

3. **Steps** (numbered, 5-15 steps)
   For each step:
   - Clear, action-oriented heading (e.g., "Step 3: Configure the database connection")
   - Brief explanation of what this step does and why
   - Code block with the exact command or code changes
   - Expected output or confirmation that the step worked

4. **Verification**
   - How to confirm the task was completed successfully
   - What the end result should look like

5. **Troubleshooting**
   - 3-5 common issues and their solutions
   - Format as: **Problem**: description → **Solution**: fix

6. **Next Steps**
   - What to do after completing this guide
   - Links to related guides or reference pages

## Style Guidelines

- ${audienceContext}
- Every step should have a concrete action and a way to verify success
- Use copy-paste ready commands — never use placeholder values without explaining them
- Show expected output after important steps
- Keep each step focused on ONE action`;
};

export default guidePromptBuilder;
