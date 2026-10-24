export { DEFAULT_DOXA_WRITER_MODEL as DEFAULT_MODEL } from "@doxahq/contracts";
export const DEFAULT_OUTPUT_DIR = ".doxa/docs";
export const DEFAULT_CONCURRENCY = 10;
/**
 * Exploration model turns when a repository map is in the prompt (the core
 * default is 50). The map already gives the orientation turns spend on
 * listing directories and opening entrypoints to find exports. What is left
 * is reading README and manifests, and confirming the routes, commands, and
 * exports the summary cites: about 15-20 turns, often with several parallel
 * reads per turn. 25 keeps headroom for that; the last turn has no tools
 * and writes the summary.
 */
export const REPO_MAP_EXPLORATION_MAX_STEPS = 25;
export const WRITER_MAX_TOKENS = 12_000;
/** The budget of a writer attempt after one stopped at the token limit. */
export const WRITER_LENGTH_RETRY_MAX_TOKENS = 20_000;
/** Characters of tool output one writer loop keeps across all of its tool calls. */
export const WRITER_MAX_TOOL_OUTPUT_CHARS = 32_000;
/** Characters one writer tool call keeps. */
export const WRITER_MAX_SINGLE_TOOL_OUTPUT_CHARS = 6_000;
/**
 * Research turns that can still add evidence: the tool output budget keeps
 * this many full tool results. A later tool result is cut to nothing, while
 * each turn still sends the whole history again.
 */
const WRITER_RESEARCH_TURNS = Math.floor(
  WRITER_MAX_TOOL_OUTPUT_CHARS / WRITER_MAX_SINGLE_TOOL_OUTPUT_CHARS,
);
/** One validate_page call, and one more to check the fix of a failed page. */
const WRITER_VALIDATION_TURNS = 2;
/** The terminal turn, where the tools are off and the model writes the page. */
const WRITER_FINAL_TURNS = 1;
/**
 * Default model turns of one agentic writer attempt, the forced
 * finalization turn included (8).
 */
export const DEFAULT_WRITER_MAX_STEPS =
  WRITER_RESEARCH_TURNS + WRITER_VALIDATION_TURNS + WRITER_FINAL_TURNS;
/** A validation-only writer validates its page once, then writes it. */
export const VALIDATION_ONLY_WRITER_MAX_STEPS = 2;
