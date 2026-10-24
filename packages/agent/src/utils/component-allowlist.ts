/**
 * Component validation for MDX render-time correctness.
 *
 * The canonical registry ships in `@doxahq/mdx-runtime`, so validation is
 * available for every repository checkout and cannot silently disable itself.
 * JSX extraction remains source-aware: fenced and inline code examples are
 * ignored because their tags are prose, not rendered components.
 */

import { RUNTIME_MDX_COMPONENT_NAMES } from "@doxahq/mdx-runtime";

const JSX_TAG_RE = /<([A-Z][A-Za-z0-9]*)\b/g;
const allowedComponents = new Set<string>(RUNTIME_MDX_COMPONENT_NAMES);

export function loadAllowedComponents(): Set<string> {
  return new Set(allowedComponents);
}

export function extractMdxComponents(content: string): string[] {
  const stripped = stripCodeRegions(content);
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  JSX_TAG_RE.lastIndex = 0;
  while ((match = JSX_TAG_RE.exec(stripped)) !== null) {
    seen.add(match[1]);
  }
  return Array.from(seen).sort();
}

function stripCodeRegions(source: string): string {
  const lines = source.split("\n");
  const output: string[] = [];
  let inFence = false;

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      inFence = !inFence;
      output.push("");
      continue;
    }
    if (inFence) {
      output.push("");
      continue;
    }
    output.push(line.replace(/`[^`\n]*`/g, ""));
  }

  return output.join("\n");
}
