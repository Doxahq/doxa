import { z } from "zod";
import { cleanInstructionText } from "./instruction-text";

/**
 * Project instructions for Doxabot: style and content preferences that the
 * project owner sets. They steer how Doxabot writes. They never change what
 * Doxabot can read, which tools it has, or where docs are published.
 *
 * Most fields are choices from fixed lists, so they cannot carry injected
 * text. Only `rules` and `context` are free text, with tight limits.
 */

export const DOXABOT_INSTRUCTION_LIMITS = {
  codeLanguages: 6,
  terms: 50,
  avoidedPerTerm: 5,
  termLength: 60,
  doNotDocument: 20,
  pathGlobLength: 200,
  rules: 10,
  ruleLength: 200,
  contextLength: 2_000,
  /** The repository instructions file shares the free-text budget. */
  repositoryFileLength: 4_000,
} as const;

export const DOXABOT_READER_AUDIENCES = ["developers", "internal", "end_users", "mixed"] as const;
export const DOXABOT_READER_LEVELS = ["beginner", "intermediate", "expert"] as const;
export const DOXABOT_TONES = ["neutral", "friendly", "formal"] as const;
export const DOXABOT_READER_ADDRESS = ["second_person", "first_person_plural"] as const;
export const DOXABOT_CODE_LANGUAGES = [
  "typescript",
  "javascript",
  "python",
  "go",
  "ruby",
  "java",
  "php",
  "rust",
  "csharp",
  "curl",
] as const;
export const DOXABOT_PAGE_TYPES = [
  "quickstart",
  "guides",
  "reference",
  "concepts",
  "troubleshooting",
] as const;

export const doxabotReaderAudienceSchema = z.enum(DOXABOT_READER_AUDIENCES);
export const doxabotReaderLevelSchema = z.enum(DOXABOT_READER_LEVELS);
export const doxabotToneSchema = z.enum(DOXABOT_TONES);
export const doxabotReaderAddressSchema = z.enum(DOXABOT_READER_ADDRESS);
export const doxabotCodeLanguageSchema = z.enum(DOXABOT_CODE_LANGUAGES);
export const doxabotPageTypeSchema = z.enum(DOXABOT_PAGE_TYPES);

/** Free text, cleaned of hidden characters, then checked for length. */
function cleanedText(maxLength: number) {
  return z.string().transform(cleanInstructionText).pipe(
    z.string().max(maxLength, `Use at most ${maxLength.toLocaleString("en-US")} characters.`),
  );
}

/** Letters, digits, spaces and - _ . ' / only: a term cannot hold a sentence of instructions. */
const TERM_PATTERN = /^[\p{L}\p{N} _.'/-]+$/u;

export const doxabotTermSchema = cleanedText(DOXABOT_INSTRUCTION_LIMITS.termLength)
  .pipe(z.string().min(1, "Enter the term.").regex(TERM_PATTERN, "Use letters, numbers, spaces and - _ . ' / only."));

export const doxabotTerminologyEntrySchema = z.object({
  use: doxabotTermSchema,
  avoid: z
    .array(doxabotTermSchema)
    .min(1, "Add at least one word to avoid.")
    .max(DOXABOT_INSTRUCTION_LIMITS.avoidedPerTerm, `Add at most ${DOXABOT_INSTRUCTION_LIMITS.avoidedPerTerm} words to avoid.`),
}).strict();

/** A repository path glob, relative to the repository root. */
export const doxabotPathGlobSchema = z
  .string()
  .trim()
  .min(1)
  .max(DOXABOT_INSTRUCTION_LIMITS.pathGlobLength)
  .regex(/^[\w*?.{},@[\]/-]+$/, "Use a path glob such as internal/**.")
  .refine((glob) => !glob.startsWith("/"), "Start the path at the repository root, without a leading /.")
  .refine((glob) => !glob.split("/").includes(".."), "A path cannot contain \"..\".");

export const doxabotInstructionsSchema = z.object({
  audience: z.object({
    reader: doxabotReaderAudienceSchema,
    level: doxabotReaderLevelSchema,
  }).strict(),
  voice: z.object({
    tone: doxabotToneSchema,
    address: doxabotReaderAddressSchema,
  }).strict(),
  /** The first language shows first in each code group. */
  codeLanguages: z
    .array(doxabotCodeLanguageSchema)
    .max(DOXABOT_INSTRUCTION_LIMITS.codeLanguages)
    .refine(isUnique, "Each language can appear once."),
  terminology: z.array(doxabotTerminologyEntrySchema).max(DOXABOT_INSTRUCTION_LIMITS.terms),
  pageTypes: z
    .array(doxabotPageTypeSchema)
    .min(1, "Keep at least one page type.")
    .refine(isUnique, "Each page type can appear once."),
  doNotDocument: z.array(doxabotPathGlobSchema).max(DOXABOT_INSTRUCTION_LIMITS.doNotDocument),
  rules: z
    .array(cleanedText(DOXABOT_INSTRUCTION_LIMITS.ruleLength).pipe(z.string().min(1)))
    .max(DOXABOT_INSTRUCTION_LIMITS.rules),
  context: cleanedText(DOXABOT_INSTRUCTION_LIMITS.contextLength),
  repositoryFile: z.object({ enabled: z.boolean() }).strict(),
}).strict();

export type DoxabotInstructions = z.output<typeof doxabotInstructionsSchema>;
export type DoxabotInstructionsInput = z.input<typeof doxabotInstructionsSchema>;
export type DoxabotCodeLanguage = z.infer<typeof doxabotCodeLanguageSchema>;
export type DoxabotPageType = z.infer<typeof doxabotPageTypeSchema>;
export type DoxabotTerminologyEntry = z.output<typeof doxabotTerminologyEntrySchema>;

/** What a project starts from before anyone saves instructions. */
export const DEFAULT_DOXABOT_INSTRUCTIONS: DoxabotInstructions = {
  audience: { reader: "developers", level: "intermediate" },
  voice: { tone: "neutral", address: "second_person" },
  codeLanguages: [],
  terminology: [],
  pageTypes: [...DOXABOT_PAGE_TYPES],
  doNotDocument: [],
  rules: [],
  context: "",
  repositoryFile: { enabled: false },
};

/**
 * A screening flag: free text that asks for more than style or content.
 * Flagged text still saves, and reaches the prompt marked as having no effect.
 */
export const doxabotInstructionFlagSchema = z.object({
  field: z.enum(["rules", "context"]),
  /** The rule index for `rules`; null for `context`. */
  index: z.number().int().min(0).nullable(),
}).strict();

export const doxabotInstructionScreeningSchema = z.object({
  method: z.enum(["heuristic", "model"]),
  flags: z.array(doxabotInstructionFlagSchema),
}).strict();

export type DoxabotInstructionFlag = z.infer<typeof doxabotInstructionFlagSchema>;
export type DoxabotInstructionScreening = z.infer<typeof doxabotInstructionScreeningSchema>;

export const doxabotInstructionsAuthorSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
}).strict();

export const doxabotInstructionsVersionSummarySchema = z.object({
  version: z.number().int().min(1),
  createdAt: z.string().datetime(),
  createdBy: doxabotInstructionsAuthorSchema.nullable(),
}).strict();

export const doxabotInstructionsVersionSchema = doxabotInstructionsVersionSummarySchema.extend({
  instructions: doxabotInstructionsSchema,
  screening: doxabotInstructionScreeningSchema,
}).strict();

export const doxabotInstructionsStateSchema = z.object({
  /** Null until someone saves instructions for the project. */
  current: doxabotInstructionsVersionSchema.nullable(),
  /** Newest first. */
  history: z.array(doxabotInstructionsVersionSummarySchema),
}).strict();

export type DoxabotInstructionsVersionSummary = z.infer<typeof doxabotInstructionsVersionSummarySchema>;
export type DoxabotInstructionsVersion = z.output<typeof doxabotInstructionsVersionSchema>;
export type DoxabotInstructionsState = z.output<typeof doxabotInstructionsStateSchema>;

/**
 * Saves a new version. `baseVersion` is the version the editor loaded (null
 * when none existed), so a save never overwrites a change it did not see.
 */
export const saveDoxabotInstructionsInputSchema = z.object({
  instructions: doxabotInstructionsSchema,
  baseVersion: z.number().int().min(1).nullable(),
}).strict();

export const restoreDoxabotInstructionsInputSchema = z.object({
  version: z.number().int().min(1),
  baseVersion: z.number().int().min(1).nullable(),
}).strict();

export type SaveDoxabotInstructionsInput = z.input<typeof saveDoxabotInstructionsInputSchema>;
export type RestoreDoxabotInstructionsInput = z.infer<typeof restoreDoxabotInstructionsInputSchema>;

/** Where the repository instructions file lives. Under `.doxa/`, so a docs site never publishes it. */
export const DOXABOT_REPOSITORY_INSTRUCTIONS_PATH = ".doxa/instructions.md";

/**
 * The repository instructions file as a run sees it. It is always read from
 * the default branch, never from a pull request.
 */
export const generationRepositoryInstructionsFileSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("disabled") }).strict(),
  z.object({ status: z.literal("missing") }).strict(),
  z.object({
    status: z.literal("unreadable"),
    reason: z.enum(["too_long", "not_text", "request_failed"]),
  }).strict(),
  z.object({
    status: z.literal("found"),
    /** Cleaned text, at most `repositoryFileLength` characters. */
    text: z.string().max(DOXABOT_INSTRUCTION_LIMITS.repositoryFileLength),
    /** True when screening found text that asks for more than style. Then the text is left out. */
    flagged: z.boolean(),
  }).strict(),
]);

/** The instructions that one generation run uses. */
export const generationInstructionsSchema = z.object({
  version: z.number().int().min(1),
  instructions: doxabotInstructionsSchema,
  screening: doxabotInstructionScreeningSchema,
  repositoryFile: generationRepositoryInstructionsFileSchema,
}).strict();

export type GenerationRepositoryInstructionsFile = z.output<typeof generationRepositoryInstructionsFileSchema>;
export type GenerationInstructions = z.output<typeof generationInstructionsSchema>;

function isUnique<T>(values: readonly T[]): boolean {
  return new Set(values).size === values.length;
}
