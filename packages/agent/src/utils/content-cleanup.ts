import { findEmbeddedFrontmatterArtifact } from "./frontmatter-artifacts";

/**
 * Content Cleanup
 *
 * Recovery transforms applied to raw model output before validation.
 *
 * The model frequently emits its full page wrapped in an outer
 * ```` ```markdown ... ``` ```` fence — sometimes preceded by a preamble
 * (e.g. "Here's the page:"). The strippers below restore the canonical
 * frontmatter-first layout so downstream validation operates on the
 * intended content rather than artifacts.
 */

const OUTER_FENCE_PATTERN =
  /(?:^|\n)```(?:markdown|md)?\s*\n([\s\S]+?)\n```\s*$/;

const INNER_FRONTMATTER_PROBE = /^---\s*\n[\s\S]*?\n---/;

/**
 * Detect and unwrap an outer markdown fence wrapper.
 *
 * Triggers ONLY when the fenced block contains frontmatter (`---`) at its
 * start — a strong signal that the model wrapped its full output rather than
 * including a legitimate code-example block. Returns the unwrapped inner
 * content, or the original content unchanged when no wrapper is found.
 */
export function unwrapOuterCodeFence(content: string): string {
  const match = content.match(OUTER_FENCE_PATTERN);
  if (!match) return content;

  const inner = match[1].trim();
  if (!INNER_FRONTMATTER_PROBE.test(inner)) return content;

  return inner;
}

/**
 * Remove residual artifacts that survive the unwrap + commentary strip.
 *
 * - Embedded duplicate frontmatter blocks (e.g. when the model emits
 *   frontmatter twice or mid-body).
 * - "cta" callout artifacts the structure agent occasionally injects.
 *
 * Note: this function deliberately does NOT strip leading/trailing code
 * fences. That responsibility now belongs to {@link unwrapOuterCodeFence},
 * which handles the open/close pair symmetrically. Stripping a single
 * trailing ```` ``` ```` here would corrupt legitimate trailing code
 * examples and orphan their opening fence.
 */
export function cleanBodyArtifacts(body: string): string {
  let cleaned = body;

  // Embedded frontmatter blocks anywhere in the body.
  cleaned = cleaned.replace(
    /\n---\s*\n\s*title:\s*[^\n]+[\s\S]*?\n---\s*\n/g,
    "\n",
  );

  // Frontmatter-like blocks at the very start (after a leading frontmatter
  // strip already ran upstream).
  cleaned = cleaned.replace(
    /^---\s*\ntitle:\s*[^\n]+[\s\S]*?\n---\s*\n/,
    "",
  );

  // Non-standard "cta" blocks the model sometimes fabricates.
  cleaned = cleaned.replace(/\n\s*cta\s*\n---[\s\S]*?---\s*/g, "");

  return cleaned.trim();
}

/**
 * Detect whether the body still contains frontmatter-shaped artifacts
 * (a `--- title: ... ---` block) after cleanup. Used as a guard before
 * accepting the body as the final output.
 */
export function hasFrontmatterArtifacts(body: string): boolean {
  return findEmbeddedFrontmatterArtifact(body) !== null;
}

/**
 * Map of fence-language aliases the writer occasionally emits onto the
 * refractor/prism language ids the docs-template ships with. Anything not
 * listed here is left alone — the template's prism plugin is configured
 * with `ignoreMissing: true`, so unmapped unknowns degrade to plain code
 * blocks rather than crashing the build.
 */
const FENCE_LANGUAGE_ALIASES: Record<string, string> = {
  mdx: "tsx",
  react: "tsx",
  vue: "html",
  svelte: "html",
  terminal: "bash",
  console: "bash",
  shell: "bash",
  sh: "bash",
  zsh: "bash",
  output: "bash",
  env: "ini",
  dotenv: "ini",
  pwsh: "powershell",
  ps1: "powershell",
};

/**
 * Rewrite fence info-strings to refractor-supported aliases. Operates only
 * on the language token (first whitespace-delimited word after the backticks)
 * so attribute tails like `{1-5}` or `title="..."` survive intact.
 *
 * Example: ` ```mdx title="x.mdx" ` → ` ```tsx title="x.mdx" `.
 */
export function normalizeFenceLanguages(body: string): string {
  return body.replace(/^(`{3,}|~{3,})([^\s`~]+)/gm, (match, fence, lang) => {
    const replacement = FENCE_LANGUAGE_ALIASES[lang.toLowerCase()];
    return replacement ? `${fence}${replacement}` : match;
  });
}

/**
 * Escape `{` and `}` in prose so MDX does not parse them as JSX expressions.
 *
 * MDX treats unescaped `{NAME}` as a JS expression and tries to evaluate
 * `NAME`. When the model emits placeholders like `AUTH_{PROVIDER}_ID` in a
 * table cell or paragraph, the page crashes at render with
 * "PROVIDER is not defined". Escaping to `\{PROVIDER\}` keeps the literal
 * braces visible without engaging the JSX parser.
 *
 * Skips fenced code blocks (``` and ~~~) and inline code spans. Idempotent
 * via negative lookbehind: already-escaped `\{` / `\}` are left alone.
 *
 * Assumes the generator emits JSX with string-quoted attributes only. If
 * dynamic expression attrs (`<Tag prop={expr}>`) are ever introduced via
 * the component playbook, this needs JSX-tag awareness.
 */
export function escapeMdxBraces(body: string): string {
  const lines = body.split("\n");
  let inFence = false;
  let fenceMarker: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);

    if (fenceMatch) {
      const marker = fenceMatch[1][0].repeat(3);
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (line.trimStart().startsWith(fenceMarker!)) {
        inFence = false;
        fenceMarker = null;
      }
      continue;
    }

    if (inFence) continue;

    const parts = line.split(/(`[^`\n]*`)/);
    lines[i] = parts
      .map((p) =>
        p.length >= 2 && p.startsWith("`") && p.endsWith("`")
          ? p
          : p.replace(/(?<!\\)\{/g, "\\{").replace(/(?<!\\)\}/g, "\\}"),
      )
      .join("");
  }

  return lines.join("\n");
}
