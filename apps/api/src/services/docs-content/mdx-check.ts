import { parseRuntimeMdx, readFrontmatter } from "@doxahq/mdx-runtime";
import {
  createValidationIssue,
  formatIssueMessage,
  type ValidationIssue,
} from "@doxahq/site-config";

const MAX_MESSAGE_LENGTH = 300;
const PARSER_PREFIX = /^Failed to parse runtime MDX(?: for [^:]*)?:\s*/;
// The parser reports positions inside the body after the frontmatter, so
// inline ranges such as "(3:1-3:7)" would point at the wrong line.
const INLINE_POSITION = /\s*\(\d+:\d+(?:-\d+:\d+)?\)/g;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]+/g;
const UNKNOWN_COMPONENT = /^Unknown MDX component: ([A-Za-z][\w.]*)$/;
const CODE_FENCE = /^\s{0,3}(`{3,}|~{3,})/;

interface SourcePosition {
  line: number;
  column: number;
}

type IssueParams = NonNullable<ValidationIssue["params"]>;

/**
 * Checks a page with the renderer's own parser, so an agent cannot save MDX
 * that the published site would fail to render.
 */
export function checkMdxSource(source: string): ValidationIssue[] {
  try {
    parseRuntimeMdx(source);
    return [];
  } catch (error) {
    return [toMdxIssue(source, error)];
  }
}

function toMdxIssue(source: string, error: unknown): ValidationIssue {
  const parsedReason = readReason(error);
  const parserPosition = findPosition(error);
  const position = parserPosition
    ? toSourcePosition(source, parserPosition)
    : findUnknownComponent(source, parsedReason);
  const positionParams: IssueParams = position ? { ...position } : {};
  const reason = fitReason(parsedReason, positionParams);
  return createValidationIssue("mdx_invalid", "", { ...positionParams, reason });
}

function fitReason(reason: string, positionParams: IssueParams): string {
  const fixedLength = formatIssueMessage("mdx_invalid", {
    ...positionParams,
    reason: "",
  }).length;
  const budget = MAX_MESSAGE_LENGTH - fixedLength;
  if (reason.length <= budget) return reason;
  return `${reason.slice(0, Math.max(0, budget - 1)).trimEnd()}…`;
}

function readReason(error: unknown): string {
  // The wrapper message carries the parser's reason. Deeper causes come from
  // tools such as acorn and are less clear ("Unexpected token").
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(PARSER_PREFIX, "")
    .replace(INLINE_POSITION, "")
    .replace(CONTROL_CHARACTERS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.$/, "");
}

function findPosition(error: unknown): SourcePosition | undefined {
  if (!(error instanceof Error)) return undefined;
  return readPosition(error) ?? findPosition(error.cause);
}

function readPosition(error: Error): SourcePosition | undefined {
  if (!("line" in error) || !("column" in error)) return undefined;
  const { line, column } = error;
  if (typeof line !== "number" || typeof column !== "number") return undefined;
  return { line, column };
}

function toSourcePosition(
  source: string,
  position: SourcePosition,
): SourcePosition {
  const { content } = readFrontmatter(source);
  const frontmatter = source.slice(0, source.length - content.length);
  const frontmatterLines = frontmatter.split("\n").length - 1;
  return { line: position.line + frontmatterLines, column: position.column };
}

/**
 * The parser names an unknown component without a position. The first use
 * of the tag outside a code fence is where the reader has to look.
 */
function findUnknownComponent(
  source: string,
  reason: string,
): SourcePosition | undefined {
  const name = UNKNOWN_COMPONENT.exec(reason)?.[1];
  if (!name) return undefined;
  const tag = new RegExp(`<${name.replace(/\./g, "\\.")}(?=[\\s/>])`);
  let fence: string | null = null;
  const lines = source.split("\n");
  for (const [index, line] of lines.entries()) {
    const marker = CODE_FENCE.exec(line)?.[1];
    if (marker && (fence === null || marker.startsWith(fence))) {
      fence = fence === null ? marker : null;
      continue;
    }
    if (fence !== null) continue;
    const match = tag.exec(line);
    if (match) return { line: index + 1, column: match.index + 1 };
  }
  return undefined;
}
