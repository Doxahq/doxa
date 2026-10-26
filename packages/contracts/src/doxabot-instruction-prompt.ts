import {
  DOXABOT_PAGE_TYPES,
  DOXABOT_REPOSITORY_INSTRUCTIONS_PATH,
  type DoxabotCodeLanguage,
  type DoxabotInstructions,
  type DoxabotPageType,
  type GenerationRepositoryInstructionsFile,
} from "./doxabot-instructions";
import {
  isContextFlagged,
  isRuleFlagged,
} from "./doxabot-instruction-screening";
import type { DoxabotInstructionScreening } from "./doxabot-instructions";

/**
 * Turns Doxabot instructions into the lines the model reads. The agent puts
 * these lines inside its fenced prompt block; the dashboard shows the same
 * lines as a preview, so owners see exactly what Doxabot gets.
 *
 * Code writes every line. Owner text appears only as JSON strings, so it
 * cannot end a quote or add a line of its own. Flagged text is left out.
 */

export const DOXABOT_CODE_LANGUAGE_LABELS: Record<DoxabotCodeLanguage, string> = {
  typescript: "TypeScript",
  javascript: "JavaScript",
  python: "Python",
  go: "Go",
  ruby: "Ruby",
  java: "Java",
  php: "PHP",
  rust: "Rust",
  csharp: "C#",
  curl: "cURL",
};

export const DOXABOT_PAGE_TYPE_LABELS: Record<DoxabotPageType, string> = {
  quickstart: "Quickstart",
  guides: "Guides",
  reference: "API reference",
  concepts: "Concepts",
  troubleshooting: "Troubleshooting",
};

const READER_TEXT: Record<DoxabotInstructions["audience"]["reader"], string> = {
  developers: "developers who integrate the product",
  internal: "the team that builds and runs the product",
  end_users: "end users of the product",
  mixed: "a mix of developers and non-developers",
};

const ADDRESS_TEXT: Record<DoxabotInstructions["voice"]["address"], string> = {
  second_person: "\"you\"",
  first_person_plural: "\"we\"",
};

export interface DoxabotInstructionPromptInput {
  instructions: DoxabotInstructions;
  screening: DoxabotInstructionScreening;
  repositoryFile?: GenerationRepositoryInstructionsFile;
}

export function renderDoxabotInstructionLines(input: DoxabotInstructionPromptInput): string[] {
  return [...structuredLines(input.instructions), ...ownerTextLines(input)];
}

function structuredLines(instructions: DoxabotInstructions): string[] {
  const lines = [
    `Readers: ${READER_TEXT[instructions.audience.reader]}, ${instructions.audience.level} level.`,
    `Tone: ${instructions.voice.tone}. Address the reader as ${ADDRESS_TEXT[instructions.voice.address]}.`,
  ];

  const [firstLanguage, ...otherLanguages] = instructions.codeLanguages.map(
    (language) => DOXABOT_CODE_LANGUAGE_LABELS[language],
  );
  if (firstLanguage) {
    lines.push(otherLanguages.length > 0
      ? `Code examples: ${firstLanguage} first, then ${otherLanguages.join(", ")}.`
      : `Code examples: ${firstLanguage}.`);
  }

  if (instructions.terminology.length > 0) {
    lines.push("Terminology:");
    for (const entry of instructions.terminology) {
      lines.push(`- Say ${quote(entry.use)}, not ${entry.avoid.map(quote).join(" or ")}.`);
    }
  }

  const skipped = DOXABOT_PAGE_TYPES.filter((type) => !instructions.pageTypes.includes(type));
  if (skipped.length > 0) {
    lines.push(`Do not write these page types: ${skipped.map((type) => DOXABOT_PAGE_TYPE_LABELS[type]).join(", ")}.`);
  }

  if (instructions.doNotDocument.length > 0) {
    lines.push(`Do not document the code under: ${instructions.doNotDocument.join(", ")}. You may still read it to understand the rest.`);
  }

  return lines;
}

function ownerTextLines({ instructions, screening, repositoryFile }: DoxabotInstructionPromptInput): string[] {
  const lines: string[] = [];

  const rules = instructions.rules.filter((_, index) => !isRuleFlagged(screening, index));
  if (rules.length > 0) {
    lines.push("Owner rules (quoted):", ...rules.map((rule) => `- ${quote(rule)}`));
  }

  if (instructions.context && !isContextFlagged(screening)) {
    lines.push("Owner context (quoted):", quote(instructions.context));
  }

  if (repositoryFile?.status === "found" && !repositoryFile.flagged) {
    lines.push(`Repository file ${DOXABOT_REPOSITORY_INSTRUCTIONS_PATH} (quoted):`, quote(repositoryFile.text));
  }

  return lines;
}

function quote(text: string): string {
  return JSON.stringify(text);
}
