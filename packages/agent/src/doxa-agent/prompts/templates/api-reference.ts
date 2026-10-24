/**
 * API Reference Documentation Prompt Template
 * Generates the API reference documentation
 */

import type { PromptBuilder, PromptContext } from '../types';
import type { FileInfo } from '../../../types';

/**
 * Find key files for API documentation
 */
function findApiFiles(files: FileInfo[]): FileInfo[] {
  const keyPatterns = [
    /index\.(ts|js|tsx|jsx)$/,
    /main\.(ts|js|tsx|jsx)$/,
    /app\.(ts|js|tsx|jsx)$/,
    /server\.(ts|js)$/,
    /api\//,
    /routes?\//,
    /controllers?\//,
    /services?\//,
    /lib\//,
    /utils?\//,
    /helpers?\//,
  ];

  const keyFiles = files.filter((file) =>
    keyPatterns.some((pattern) => pattern.test(file.relativePath))
  );

  // Limit to top 15 files to avoid token limits
  return keyFiles.slice(0, 15);
}

/**
 * Build the API reference documentation prompt
 */
export const apiReferencePromptBuilder: PromptBuilder = (context: PromptContext): string => {
  const { projectName, languages, files, answers } = context;

  // Find API-relevant files
  const apiFiles = findApiFiles(files);

  if (apiFiles.length === 0) {
    // Fallback to any files if no API files found
    apiFiles.push(...files.slice(0, 10));
  }

  // Build content from API files
  const fileContents = apiFiles
    .map((f) => `--- ${f.relativePath} ---\n${f.content.slice(0, 2500)}`)
    .join('\n\n');

  // Determine API documentation style
  const apiStyle = answers.audience === 'internal'
    ? 'Include internal APIs and implementation details.'
    : 'Focus on public APIs that users will interact with.';

  return `Generate API reference documentation for "${answers.title || projectName}".

## Project Context

- **Title**: ${answers.title || projectName}
- **Description**: ${answers.description || 'Not provided'}
- **Target Audience**: ${answers.audience === 'internal' ? 'Internal team' : 'External developers'}
- **Additional Context**: ${answers.context || 'None provided'}
- **Languages**: ${languages.join(', ')}

## Source Code (Key API Files)

${fileContents}

## Requirements

Generate comprehensive API reference documentation that includes:

1. **API Overview**
   - Brief introduction to the available APIs
   - How the APIs are organized

2. **Modules/Files**
   For each module or file with exports:
   - Module description
   - List of exports

3. **Functions**
   For each function:
   - Function name and description
   - Parameters with types and descriptions
   - Return type and description
   - Usage example

4. **Classes** (if applicable)
   For each class:
   - Class description
   - Constructor parameters
   - Properties
   - Methods with signatures
   - Usage example

5. **Types/Interfaces** (if applicable)
   For each type:
   - Type name and description
   - Properties/fields
   - Usage context

6. **Constants/Enums** (if applicable)
   - Name and description
   - Available values

## Formatting Guidelines

- ${apiStyle}
- Use proper TypeScript/JavaScript code blocks
- Include JSDoc-style descriptions
- Use tables for parameters and properties
- Provide practical, runnable examples
- Group related APIs together
- Length: As comprehensive as needed to cover the APIs`;
};

export default apiReferencePromptBuilder;
