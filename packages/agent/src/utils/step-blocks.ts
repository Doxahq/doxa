/**
 * Step structure checks for writer output.
 *
 * The renderer's `<Step>` takes no props and numbers each child element, so
 * every step must be a `<StepItem title="…">` inside one `<Step>`:
 *
 *     <Step>
 *     <StepItem title="Install">Add the package.</StepItem>
 *     <StepItem title="Run">Run the client.</StepItem>
 *     </Step>
 *
 * Models often write one `<Step title="…">` per step instead. The renderer then
 * drops the title and numbers every paragraph and code block of the body as a
 * step of its own. {@link normalizeStepBlocks} rewrites that shape; the
 * shapes it cannot rewrite safely are reported by {@link findStepProblems}.
 */

import { nextFenceState, type FenceState } from "./markdown-fences";

export type StepProblemKind =
  /** `<Step title="…">…</Step>`: rewritable to a `<StepItem>`. */
  | "titledStep"
  /** `<Step>` with props other than a lone `title`. */
  | "stepProps"
  /** Text or a code block directly inside `<Step>`, outside a `<StepItem>`. */
  | "looseContent"
  /** `<StepItem>` that is not inside a `<Step>`. */
  | "orphanStepItem";

export interface StepProblem {
  kind: StepProblemKind;
  /** 0-based line in the body. */
  line: number;
  /** The trimmed source line. */
  snippet: string;
}

const STEP_OPEN = /^\s*<Step(\s[^>]*)?>\s*$/;
const STEP_CLOSE = /^\s*<\/Step>\s*$/;
const TITLED_STEP_OPEN = /^\s*<Step\s+title=(?:"([^"]*)"|'([^']*)'|\{\s*"([^"]*)"\s*\})\s*>(.*)$/;
const STEP_ITEM_TAG = /<\s*(\/?)\s*StepItem\b[^>]*?(\/?)>/g;
const STEP_TAG = /<\s*\/?\s*Step\b/;

/**
 * Every Step misuse in a page body, in source order. Lines inside fenced code
 * blocks that are not themselves inside a step are skipped, so examples of the
 * wrong shape in a code fence are not reported.
 */
export function findStepProblems(body: string): StepProblem[] {
  const lines = body.split("\n");
  const problems: StepProblem[] = [];
  let fence: FenceState | undefined;
  /** Open `<Step>` blocks; `titled` ones act as a step item themselves. */
  const steps: Array<{ titled: boolean }> = [];
  let itemDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    const wasInFence = fence !== undefined;
    fence = nextFenceState(line, fence);
    const innermost = steps.at(-1);
    const insideItem = itemDepth > 0 || innermost?.titled === true;

    if (wasInFence || fence !== undefined) {
      // A fence that opens directly inside <Step> is a loose code block.
      if (!wasInFence && innermost && !insideItem) {
        problems.push({ kind: "looseContent", line: i, snippet: trimmed });
      }
      continue;
    }

    if (STEP_CLOSE.test(line)) {
      steps.pop();
      continue;
    }

    const titled = TITLED_STEP_OPEN.exec(line);
    if (titled) {
      problems.push({ kind: "titledStep", line: i, snippet: trimmed });
      const rest = titled[4] ?? "";
      // A one-line `<Step title="…">text</Step>` opens and closes at once.
      if (!/<\/Step>\s*$/.test(rest)) steps.push({ titled: true });
      continue;
    }

    const open = STEP_OPEN.exec(line);
    if (open) {
      if (open[1]?.trim()) {
        problems.push({ kind: "stepProps", line: i, snippet: trimmed });
      }
      steps.push({ titled: false });
      continue;
    }

    // Tags quoted in inline code, such as "use `<Step>`", are prose.
    const code = withoutInlineCode(line);
    if (STEP_TAG.test(code) && !/StepItem/.test(code)) {
      // Step tags that share a line with content are not a shape we write.
      problems.push({ kind: "looseContent", line: i, snippet: trimmed });
      continue;
    }

    let sawItemTag = false;
    STEP_ITEM_TAG.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = STEP_ITEM_TAG.exec(code)) !== null) {
      sawItemTag = true;
      const [, closing, selfClosing] = match;
      if (closing === "/") {
        itemDepth = Math.max(0, itemDepth - 1);
        continue;
      }
      if (!innermost) {
        problems.push({ kind: "orphanStepItem", line: i, snippet: trimmed });
      }
      if (selfClosing !== "/") itemDepth++;
    }
    if (sawItemTag) continue;

    if (trimmed.length > 0 && innermost && !insideItem) {
      problems.push({ kind: "looseContent", line: i, snippet: trimmed });
    }
  }

  return problems;
}

/**
 * Rewrite each run of `<Step title="…">…</Step>` blocks (separated only by
 * blank lines) into one `<Step>` with a `<StepItem title="…">` per block. The
 * block bodies, code fences included, are kept byte for byte. A block that
 * already holds a `<StepItem>` or another `<Step>` is left alone, as is
 * everything inside a code fence.
 */
export function normalizeStepBlocks(body: string): string {
  if (!/<Step\s+title=/.test(body)) return body;

  const lines = body.split("\n");
  const out: string[] = [];
  let fence: FenceState | undefined;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const wasInFence = fence !== undefined;
    fence = nextFenceState(line, fence);
    if (wasInFence || fence !== undefined) {
      out.push(line);
      i++;
      continue;
    }

    const run = readTitledStepRun(lines, i);
    if (!run) {
      out.push(line);
      i++;
      continue;
    }

    const indent = /^\s*/.exec(line)?.[0] ?? "";
    out.push(`${indent}<Step>`);
    run.items.forEach((item, index) => {
      if (index > 0) out.push("");
      out.push(`${indent}<StepItem title=${JSON.stringify(item.title)}>`);
      out.push(...item.body);
      out.push(`${indent}</StepItem>`);
    });
    out.push(`${indent}</Step>`);
    i = run.end;
  }

  return out.join("\n");
}

/** The line with its inline code spans removed. */
function withoutInlineCode(line: string): string {
  return line.replace(/`+[^`]*`+/g, "");
}

interface TitledStepRun {
  items: Array<{ title: string; body: string[] }>;
  /** Index of the first line after the run. */
  end: number;
}

function readTitledStepRun(lines: string[], start: number): TitledStepRun | null {
  const items: TitledStepRun["items"] = [];
  let i = start;

  while (i < lines.length) {
    const block = readTitledStep(lines, i);
    if (!block) break;
    items.push(block.item);
    i = block.end;

    // Blank lines between blocks belong to the run only if another block follows.
    let next = i;
    while (next < lines.length && (lines[next] ?? "").trim() === "") next++;
    if (next < lines.length && TITLED_STEP_OPEN.test(lines[next] ?? "")) {
      i = next;
      continue;
    }
    break;
  }

  return items.length > 0 ? { items, end: i } : null;
}

function readTitledStep(
  lines: string[],
  start: number,
): { item: { title: string; body: string[] }; end: number } | null {
  const open = TITLED_STEP_OPEN.exec(lines[start] ?? "");
  if (!open) return null;
  const title = open[1] ?? open[2] ?? open[3] ?? "";
  const rest = open[4] ?? "";

  const inline = /^(.*)<\/Step>\s*$/.exec(rest);
  if (inline) {
    const text = inline[1]?.trim() ?? "";
    return { item: { title, body: text ? [text] : [] }, end: start + 1 };
  }
  if (rest.trim()) return null;

  const body: string[] = [];
  let fence: FenceState | undefined;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const wasInFence = fence !== undefined;
    fence = nextFenceState(line, fence);
    if (!wasInFence && fence === undefined) {
      if (STEP_CLOSE.test(line)) {
        return { item: { title, body: trimBlankEdges(body) }, end: i + 1 };
      }
      // Nested steps or items are not a shape this rewrite understands.
      if (STEP_TAG.test(line) || /<\s*\/?\s*StepItem\b/.test(line)) return null;
    }
    body.push(line);
  }
  return null;
}

/** Keep one blank line at each edge so code fences stay separated from the tags. */
function trimBlankEdges(body: string[]): string[] {
  let first = 0;
  let last = body.length;
  while (first < last && (body[first] ?? "").trim() === "") first++;
  while (last > first && (body[last - 1] ?? "").trim() === "") last--;
  const kept = body.slice(first, last);
  return kept.length > 0 ? ["", ...kept, ""] : [];
}
