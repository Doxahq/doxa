/**
 * Architecture Documentation Prompt Template
 * Generates the project architecture documentation
 */

import type { PromptBuilder, PromptContext } from '../types';

/**
 * Build the architecture documentation prompt
 */
export const architecturePromptBuilder: PromptBuilder = (context: PromptContext): string => {
  const { projectName, languages, files, totalFiles, answers } = context;

  // Get full file structure
  const fileList = files.map((f) => f.relativePath).join('\n');

  // Get sample content from key architectural files
  const keyFiles = files
    .filter(
      (f) =>
        f.relativePath.includes('index') ||
        f.relativePath.includes('main') ||
        f.relativePath.includes('app') ||
        f.relativePath.includes('server') ||
        f.relativePath.includes('config')
    )
    .slice(0, 5);

  const sampleContent = keyFiles
    .map((f) => `--- ${f.relativePath} ---\n${f.content.slice(0, 1500)}`)
    .join('\n\n');

  // Determine documentation depth
  const depthGuide = answers.audience === 'internal'
    ? 'Include implementation details and internal architectural decisions.'
    : 'Focus on high-level architecture that helps users understand how to extend or integrate.';

  return `Generate architecture documentation for "${answers.title || projectName}".

## Project Context

- **Title**: ${answers.title || projectName}
- **Description**: ${answers.description || 'Not provided'}
- **Target Audience**: ${answers.audience === 'internal' ? 'Internal team' : 'External developers'}
- **Additional Context**: ${answers.context || 'None provided'}

## Technical Overview

- **Languages**: ${languages.join(', ')}
- **Total Files**: ${totalFiles}

## Complete Project Structure

\`\`\`
${fileList}
\`\`\`

## Sample Code (Key Files)

${sampleContent}

## Requirements

Write architecture documentation that includes:

1. **Architecture Overview**
   - High-level system design
   - Main components and their relationships
   - Include a Mermaid diagram if helpful

2. **Directory Structure**
   - Explain the purpose of each major directory
   - Describe the organization philosophy

3. **Key Components**
   - Identify and describe the core modules
   - Explain their responsibilities
   - Show how they interact

4. **Data Flow** (if applicable)
   - How data moves through the system
   - Entry points and exit points
   - Processing pipeline

5. **Design Patterns**
   - Identify patterns used in the codebase
   - Explain why they were chosen

6. **Extension Points** (for public docs)
   - How can users extend or customize?
   - Plugin systems or hooks

## Style Guidelines

- ${depthGuide}
- Use Mermaid diagrams for visual representation where helpful
- Reference specific files when discussing components
- Be specific about file locations and module boundaries
- Length: Comprehensive, approximately 600-900 words`;
};

export default architecturePromptBuilder;
