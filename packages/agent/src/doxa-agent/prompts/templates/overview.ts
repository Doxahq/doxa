/**
 * Overview Documentation Prompt Template
 * Generates the main project overview document
 */

import type { PromptBuilder, PromptContext } from '../types';

/**
 * Build the overview documentation prompt
 */
export const overviewPromptBuilder: PromptBuilder = (context: PromptContext): string => {
  const { projectName, languages, files, totalFiles, answers, packageJson } = context;

  // Get file structure (limit for token efficiency)
  const fileList = files
    .slice(0, 50)
    .map((f) => f.relativePath)
    .join('\n');

  // Determine tone based on audience
  const audienceTone = answers.audience === 'internal'
    ? 'technical and assumes team familiarity with the codebase'
    : 'welcoming and accessible to newcomers';

  return `Generate a comprehensive project overview document for "${answers.title || projectName}".

## Project Information

- **Title**: ${answers.title || projectName}
- **Description**: ${answers.description || 'Not provided'}
- **Audience**: ${answers.audience === 'internal' ? 'Internal team documentation' : 'Public-facing documentation for users'}
- **Additional Context**: ${answers.context || 'None provided'}

## Technical Details

- **Languages**: ${languages.join(', ')}
- **Total Files**: ${totalFiles}

## Project Structure

\`\`\`
${fileList}
\`\`\`

${packageJson ? `## Package Configuration\n\n\`\`\`json\n${packageJson}\n\`\`\`\n` : ''}

## Requirements

Write a project overview that includes:

1. **Introduction**: A clear, engaging project description that incorporates the user's provided description
2. **Key Features**: Highlight the main features and capabilities of this project
3. **Technology Stack**: List and briefly explain the technologies used
4. **Project Structure**: Provide a high-level overview of how the project is organized
5. **Use Cases**: When and why would someone use this project?

## Style Guidelines

- Tone should be ${audienceTone}
- Use the provided title "${answers.title || projectName}" as the main heading
- Include the description naturally in the introduction
- Make it easy to scan with clear headers and bullet points
- Length: Comprehensive but focused, approximately 500-800 words`;
};

export default overviewPromptBuilder;
