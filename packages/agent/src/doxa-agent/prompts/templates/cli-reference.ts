/**
 * CLI Reference Documentation Prompt Template
 * Generates documentation for individual CLI commands
 */

import type { PromptBuilder, PromptContext } from '../types';

/**
 * Build the CLI reference documentation prompt
 */
export const cliReferencePromptBuilder: PromptBuilder = (context: PromptContext): string => {
  const { projectName, answers } = context;

  return `Generate CLI command reference documentation for "${answers.title || projectName}".

## Project Context

- **Title**: ${answers.title || projectName}
- **Description**: ${answers.description || 'Not provided'}
- **Target Audience**: ${answers.audience === 'internal' ? 'Internal team' : 'External users/developers'}

## Requirements

Write a comprehensive CLI reference page that includes:

1. **Command Synopsis**
   - Full usage syntax with all arguments and options
   - Use standard CLI documentation format: \`command [options] <required-arg> [optional-arg]\`

2. **Description**
   - Clear explanation of what the command does
   - When and why to use it

3. **Arguments**
   - Table with name, required/optional, description
   - Type information if applicable

4. **Options**
   - Table with long flag, short flag, default value, description
   - Group related options together

5. **Examples**
   - 3-5 practical, real-world examples
   - Include expected output for each example
   - Progress from simple to advanced usage

6. **Exit Codes** (if applicable)
   - Document non-zero exit codes and their meanings

7. **Related Commands**
   - List related commands with brief descriptions

## Formatting Guidelines

- Use code blocks with \`bash\` language identifier for all commands
- Use tables for arguments and options
- Include copy-paste ready examples
- Show expected output in separate code blocks`;
};

export default cliReferencePromptBuilder;
