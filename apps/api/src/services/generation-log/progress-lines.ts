import type { GenerationLogPhase } from "@doxahq/contracts";
import { qualityRuleText } from "./quality-rules";
import {
  attemptText,
  hidden,
  line,
  pageCount,
  quoted,
  type GenerationLogLine,
} from "./lines";

/**
 * The progress lines of the documentation agent: the `analysis_progress`,
 * `stage_progress` and `page_write_completed` events. The agent writes them
 * as free text with tool names, models and attempt counters, so each known
 * message gets a line for people here. A message that no rule knows is
 * hidden: a new agent message stays private until it gets a rule.
 */
export function progressLine(message: string, data: Record<string, unknown>): GenerationLogLine | null {
  const phase = progressPhase(data.stage);
  const title = typeof data.currentItem === "string" && data.currentItem.trim()
    ? data.currentItem.trim()
    : null;
  const text = message.trim();

  for (const rule of PROGRESS_RULES) {
    const match = rule.pattern.exec(text);
    if (match) return rule.line(match, { phase, title });
  }
  return hidden;
}

interface ProgressContext {
  phase: GenerationLogPhase;
  /** The page title that a writing line is about, from `data.currentItem`. */
  title: string | null;
}

interface ProgressRule {
  pattern: RegExp;
  line: (match: RegExpExecArray, context: ProgressContext) => GenerationLogLine | null;
}

/** The agent progress stages (`AgentProgressEvent.stage`), by log phase. */
function progressPhase(stage: unknown): GenerationLogPhase {
  switch (stage) {
    case "analyzing":
      return "analyze";
    case "proposing":
    case "ordering":
      return "plan";
    default:
      return "write";
  }
}

/** Names for people of the workspace tools that the agent explores with. */
const TOOL_ACTIVITY: Record<string, string> = {
  Read: "Reading files.",
  Glob: "Finding files.",
  Grep: "Searching the code.",
  Bash: "Running a command.",
};

const PROGRESS_RULES: readonly ProgressRule[] = [
  // Analysis
  { pattern: /^Starting project analysis/, line: () => hidden },
  { pattern: /^Checking analysis state/, line: () => hidden },
  { pattern: /^Saving analysis to cache/, line: () => hidden },
  { pattern: /^(Incremental analysis|Analysis) complete$/, line: () => hidden },
  {
    pattern: /^Exploring codebase \((.+)\)\.\.\.$/,
    line: ([, tool], { phase }) =>
      line(phase, TOOL_ACTIVITY[tool.trim()] ?? "Exploring the codebase."),
  },
  {
    pattern: /^Exploring codebase\.\.\.$/,
    line: (_, { phase }) => line(phase, "Exploring the codebase."),
  },
  {
    pattern: /^Exploration failed \(.*\), retrying \((\d+)\/(\d+)\)\.\.\.$/,
    line: ([, attempt, max], { phase }) =>
      line(
        phase,
        `Exploring the codebase failed. Trying again (${attemptText(attempt, max)}).`,
        "warning",
      ),
  },
  {
    pattern: /^Generating project analysis/,
    line: (_, { phase }) => line(phase, "Writing the project analysis."),
  },
  {
    pattern: /^Parsing (analysis results|incremental analysis)/,
    line: (_, { phase }) => line(phase, "Checking the analysis."),
  },
  {
    pattern: /^Retrying JSON generation \(attempt (\d+)\/(\d+)\)/,
    line: ([, attempt, max], { phase }) =>
      line(
        phase,
        `The analysis was not complete. Writing it again (${attemptText(attempt, max)}).`,
        "warning",
      ),
  },
  {
    pattern: /^Updating analysis with (\d+) changed file\(s\)/,
    line: ([, count], { phase }) =>
      line(phase, `Updating the analysis with ${fileCount(count)} that changed.`),
  },
  {
    pattern: /^(\d+) file\(s\) changed, (\d+) deleted/,
    line: ([, changed, deleted], { phase }) =>
      line(
        phase,
        `${capitalize(fileCount(changed))} changed and ${fileCount(deleted)} were deleted. Updating the analysis.`,
      ),
  },
  {
    pattern: /^Reading API spec files/,
    line: (_, { phase }) => line(phase, "Reading the API spec files."),
  },
  {
    pattern: /^Using cached analysis \(no changes since (\w+)\)$/,
    line: ([, commit], { phase }) =>
      line(phase, `Reused the analysis of an earlier run. No code changed since commit ${commit}.`),
  },
  {
    pattern: /^Using cached analysis$/,
    line: (_, { phase }) => line(phase, "Reused the analysis of an earlier run."),
  },
  {
    pattern: /^Reusing published project analysis/,
    line: (_, { phase }) => line(phase, "Reused the published project analysis."),
  },
  {
    pattern: /^Analysis failed/,
    line: (_, { phase }) => line(phase, "The analysis failed.", "error"),
  },
  {
    pattern: /^Extracting REST endpoints from (\d+) route files/,
    line: ([, count], { phase }) =>
      line(phase, `Finding REST endpoints in ${count} route ${Number(count) === 1 ? "file" : "files"}.`),
  },
  {
    pattern: /^Repository map ready \((\d+) files/,
    line: ([, count], { phase }) => line(phase, `Mapped ${fileCount(count)} of the repository.`),
  },

  // Structure and order
  { pattern: /^(Generating|Suggesting) documentation structure/, line: () => hidden },
  { pattern: /^Parsing structure/, line: () => hidden },
  { pattern: /^Documentation structure ready$/, line: () => hidden },
  { pattern: /^Documentation order finalized$/, line: () => hidden },
  { pattern: /^Ordering pass skipped/, line: () => hidden },
  {
    pattern: /^Retrying structure generation \(attempt (\d+)\/(\d+)\)/,
    line: ([, attempt, max], { phase }) =>
      line(
        phase,
        `The plan had problems. Planning again (${attemptText(attempt, max)}).`,
        "warning",
      ),
  },
  {
    pattern: /^Retrying structure review with validation feedback \(attempt (\d+)\/(\d+)\)/,
    line: ([, attempt, max], { phase }) =>
      line(
        phase,
        `The review found problems. Reviewing again (${attemptText(attempt, max)}).`,
        "warning",
      ),
  },
  {
    pattern: /^Structure suggestion failed/,
    line: (_, { phase }) => line(phase, "Planning the structure failed.", "error"),
  },
  {
    pattern: /^Determining documentation order/,
    line: (_, { phase }) => line(phase, "Ordering the pages."),
  },
  {
    pattern: /^Ordering pass failed/,
    line: (_, { phase }) =>
      line(phase, "Ordering the pages failed. The planned order stays.", "warning"),
  },

  // Writing
  { pattern: /^Preparing to write documentation/, line: () => hidden },
  { pattern: /^Ranking pages by complexity/, line: () => hidden },
  { pattern: /^Selected \d+ pages for test/, line: () => hidden },
  { pattern: /^Failed \d+\/\d+ selected test page/, line: () => hidden },
  { pattern: /^Selected test pages failed/, line: () => hidden },
  { pattern: /^Test generation complete/, line: () => hidden },
  { pattern: /^Generated \d+ documentation pages/, line: () => hidden },
  { pattern: /^Documentation generation complete$/, line: () => hidden },
  {
    pattern: /^All (\d+) pages up to date/,
    line: ([, count], { phase }) =>
      line(phase, `All ${pageCount(count)} are up to date. Reused them.`),
  },
  {
    pattern: /^Regenerating (\d+) page\(s\), skipping (\d+) cached page\(s\)$/,
    line: ([, written, reused], { phase }) =>
      line(phase, `Writing ${pageCount(written)}. Reused ${pageCount(reused)} that did not change.`),
  },
  {
    pattern: /^(?:\[\d+\/\d+\] )?Writing: (.+?) \(/,
    line: ([, title], context) => line(context.phase, `Wrote ${quoted(context.title ?? title)}.`),
  },
  {
    pattern: /^Wrote (.+)$/,
    line: ([, title], context) => line(context.phase, `Wrote ${quoted(context.title ?? title)}.`),
  },
  {
    pattern: /^Retrying failed page: (.+?) \(retry (\d+)/,
    line: ([, title, retry], context) =>
      line(
        context.phase,
        `Writing ${quoted(context.title ?? title)} again (retry ${retry}).`,
        "warning",
      ),
  },
  {
    pattern: /^Recovered failed page: (.+)$/,
    line: ([, title], context) =>
      line(context.phase, `Recovered ${quoted(context.title ?? title)}.`),
  },
  {
    pattern: /^Skipped failed page: (.+?) — /,
    line: ([, title], context) =>
      line(
        context.phase,
        `${quoted(context.title ?? title)} could not be written. It was skipped.`,
        "warning",
      ),
  },
  {
    pattern: /^Skipped quality-failed page: (.+?) — /,
    line: ([, title], context) =>
      line(
        context.phase,
        `${quoted(context.title ?? title)} did not pass the quality checks. It was skipped.`,
        "warning",
      ),
  },
  {
    pattern: /^Quality repair (\d+)\/(\d+) for (.+?) — .*rule: (.+)$/,
    line: ([, repair, max, title, rule], context) =>
      line(
        context.phase,
        `Improving ${quoted(context.title ?? title)}: ${qualityRuleText(rule)} (fix ${repair} of ${max}).`,
      ),
  },
  {
    pattern: /^Quality repair candidate (\d+)\/(\d+) rejected for (.+?) — /,
    line: ([, repair, max, title], context) =>
      line(
        context.phase,
        `A fix for ${quoted(context.title ?? title)} did not pass the checks (fix ${repair} of ${max}).`,
        "warning",
      ),
  },
  {
    pattern: /^Section repair \d+\/\d+ fell back to a whole-page repair for (.+?) — /,
    line: ([, title], context) =>
      line(context.phase, `Fixing all of ${quoted(context.title ?? title)}, not only one section.`),
  },
];

function fileCount(value: string): string {
  return `${value} ${Number(value) === 1 ? "file" : "files"}`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
