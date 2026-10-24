import type { DocsQualityIssue, ProjectAnalysis } from "../types";

const QUICKSTART_MAX_PROSE_WORDS = 650;
const SHELL_FENCE_LANGUAGES = new Set([
  "bash",
  "console",
  "fish",
  "sh",
  "shell",
  "zsh",
]);
const JAVASCRIPT_FENCE_LANGUAGES = new Set([
  "javascript",
  "js",
  "jsx",
  "tsx",
  "typescript",
  "ts",
]);
const COMMON_SHELL_VARIABLES = new Set([
  "HOME",
  "OLDPWD",
  "PATH",
  "PWD",
  "SHELL",
  "TMPDIR",
  "USER",
]);
const JAVASCRIPT_GLOBAL_CONSTRUCTORS = new Set([
  "AbortController",
  "Array",
  "Blob",
  "Date",
  "Error",
  "FormData",
  "Headers",
  "Map",
  "Object",
  "Promise",
  "RegExp",
  "Request",
  "Response",
  "Set",
  "URL",
  "URLSearchParams",
  "WeakMap",
  "WeakSet",
]);
const INSTALL_COMMAND_PATTERNS = [
  /^(?:npm\s+(?:install|i)|pnpm\s+(?:add|install)|yarn\s+add|bun\s+add|deno\s+add)\b/i,
  /^(?:pip(?:3|x)?\s+install|python(?:3)?\s+-m\s+pip\s+install|poetry\s+add|uv\s+add|conda\s+install|mamba\s+install)\b/i,
  /^(?:cargo\s+add|go\s+get|dotnet\s+add\b.*\bpackage|composer\s+require|gem\s+install|luarocks\s+install)\b/i,
  /^(?:conan\s+install|vcpkg\s+install|cmake\s+--install|make\s+install|meson\s+install)\b/i,
  /^(?:brew\s+install|apt(?:-get)?\s+install|apk\s+add|dnf\s+install|pacman\s+-S|zypper\s+install)\b/i,
] as const;

export interface QuickstartValidationContext {
  title: string;
  route: string;
  body: string;
  analysis?: ProjectAnalysis;
  issues: DocsQualityIssue[];
}

export function isQuickstartPage(title: string, route: string): boolean {
  return (
    /\b(?:quick\s*start|getting\s+started)\b/i.test(title) ||
    /\/(?:quick-?start|getting-started)(?:\/|$)/i.test(route)
  );
}

export function validateQuickstartQuality(
  context: QuickstartValidationContext,
): void {
  validateProseLength(context);
  validateShellVariables(context);
  validateJavaScriptImports(context);
  validateInstallCommands(context);
}

function validateProseLength(context: QuickstartValidationContext): void {
  const proseWords = countProseWords(context.body);
  if (proseWords <= QUICKSTART_MAX_PROSE_WORDS) return;

  context.issues.push({
    rule: "quickstart-too-long",
    // A style rule: it reports, but it never stops a generation.
    severity: "warning",
    title: context.title,
    route: context.route,
    message:
      `Quickstart prose has ${proseWords} words; keep it at or below ` +
      `${QUICKSTART_MAX_PROSE_WORDS} words and move deeper detail to linked guides.`,
  });
}

function validateShellVariables(context: QuickstartValidationContext): void {
  const assigned = new Set(COMMON_SHELL_VARIABLES);
  const reported = new Set<string>();

  for (const block of extractFencedCodeBlocks(context.body)) {
    if (!isShellOrEnvBlock(block)) continue;

    for (const line of block.content.split("\n")) {
      extractShellAssignments(line).forEach((variable) => assigned.add(variable));
      if (block.language === "dotenv") continue;
      reportUndefinedVariables(context, line, assigned, reported);
    }
  }
}

function reportUndefinedVariables(
  context: QuickstartValidationContext,
  line: string,
  assigned: Set<string>,
  reported: Set<string>,
): void {
  for (const variable of extractShellVariableUsages(line)) {
    if (assigned.has(variable) || reported.has(variable)) continue;
    reported.add(variable);
    context.issues.push({
      rule: "quickstart-undefined-shell-variable",
      severity: "error",
      title: context.title,
      route: context.route,
      message:
        `Quickstart uses $${variable} before assigning it. Add a ` +
        "copy-paste assignment earlier in the workflow.",
      excerpt: line.trim().slice(0, 240),
    });
  }
}

function validateJavaScriptImports(
  context: QuickstartValidationContext,
): void {
  for (const block of extractFencedCodeBlocks(context.body)) {
    if (!JAVASCRIPT_FENCE_LANGUAGES.has(block.language)) continue;
    reportMissingConstructors(context, block.content);
  }
}

function reportMissingConstructors(
  context: QuickstartValidationContext,
  content: string,
): void {
  const available = new Set([
    ...extractImportedIdentifiers(content),
    ...extractDeclaredIdentifiers(content),
    ...JAVASCRIPT_GLOBAL_CONSTRUCTORS,
  ]);
  const missing = new Set<string>();

  for (const match of content.matchAll(/\bnew\s+([A-Z_$][\w$]*)\b/g)) {
    const identifier = match[1];
    if (!available.has(identifier)) missing.add(identifier);
  }

  for (const identifier of missing) {
    context.issues.push({
      rule: "quickstart-missing-import",
      severity: "error",
      title: context.title,
      route: context.route,
      message:
        `Quickstart constructs ${identifier} without importing or defining it ` +
        "in the same example.",
      excerpt: `new ${identifier}`,
    });
  }
}

function validateInstallCommands(
  context: QuickstartValidationContext,
): void {
  const canonicalCommands = canonicalInstallCommands(context.analysis);
  if (canonicalCommands.size === 0) return;

  const pageCommands = extractInstallCommands(context.body);
  if (pageCommands.length === 0) {
    reportMissingCanonicalInstall(context);
    return;
  }

  pageCommands
    .filter((command) => !canonicalCommands.has(command))
    .forEach((command) => reportUngroundedInstall(context, command));
}

/**
 * Only shell install commands count. The analysis also records install steps
 * such as "open the Extensions panel and click Install", which no shell block
 * can contain.
 */
function canonicalInstallCommands(
  analysis: ProjectAnalysis | undefined,
): Set<string> {
  return new Set(
    (analysis?.documentationIntent?.canonicalWorkflows ?? [])
      .flatMap((workflow) => workflow.installCommands)
      .map(normalizeShellCommand)
      .filter(isInstallCommand),
  );
}

function extractInstallCommands(body: string): string[] {
  return extractFencedCodeBlocks(body)
    .filter((block) => SHELL_FENCE_LANGUAGES.has(block.language))
    .flatMap((block) => block.content.split("\n"))
    .map(normalizeShellCommand)
    .filter(isInstallCommand);
}

function reportMissingCanonicalInstall(
  context: QuickstartValidationContext,
): void {
  context.issues.push({
    rule: "quickstart-missing-canonical-install",
    // A completeness rule: a page without the command is still correct, so it never stops a generation.
    severity: "warning",
    title: context.title,
    route: context.route,
    message:
      "Quickstart omits the source-backed install command from the canonical workflow.",
  });
}

function reportUngroundedInstall(
  context: QuickstartValidationContext,
  command: string,
): void {
  context.issues.push({
    rule: "quickstart-ungrounded-install",
    severity: "error",
    title: context.title,
    route: context.route,
    message:
      "Quickstart contains an install command that is not present in the " +
      "source-backed canonical workflows.",
    excerpt: command.slice(0, 240),
  });
}

interface FencedCodeBlock {
  language: string;
  content: string;
}

function extractFencedCodeBlocks(content: string): FencedCodeBlock[] {
  const blocks: FencedCodeBlock[] = [];
  const pattern = /```([^\n`]*)\n([\s\S]*?)```/g;
  for (const match of content.matchAll(pattern)) {
    blocks.push({
      language: (match[1]?.trim().split(/\s+/)[0] ?? "").toLowerCase(),
      content: match[2] ?? "",
    });
  }
  return blocks;
}

function isShellOrEnvBlock(block: FencedCodeBlock): boolean {
  return SHELL_FENCE_LANGUAGES.has(block.language) ||
    block.language === "dotenv";
}

function countProseWords(content: string): number {
  const prose = content
    .replace(/```[^\n`]*\n[\s\S]*?```/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[`*_#[\]()>-]/g, " ");
  return prose.match(/\b[\p{L}\p{N}][\p{L}\p{N}'’-]*\b/gu)?.length ?? 0;
}

function extractShellAssignments(line: string): string[] {
  const assignments: string[] = [];
  const pattern =
    /(?:^|[\s;])(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/g;
  for (const match of line.matchAll(pattern)) assignments.push(match[1]);
  return assignments;
}

function extractShellVariableUsages(line: string): string[] {
  const variables: string[] = [];
  const pattern =
    /(?<!\\)\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;
  for (const match of line.matchAll(pattern)) {
    const variable = match[1] ?? match[2];
    if (variable) variables.push(variable);
  }
  return variables;
}

function extractImportedIdentifiers(content: string): string[] {
  const identifiers = new Set<string>();
  extractDefaultImports(content, identifiers);
  extractNamespaceImports(content, identifiers);
  extractNamedImports(content, identifiers);
  extractCommonJsImports(content, identifiers);
  return Array.from(identifiers);
}

function extractDefaultImports(
  content: string,
  identifiers: Set<string>,
): void {
  for (const match of content.matchAll(
    /\bimport\s+([A-Za-z_$][\w$]*)\s*(?:,|from)/g,
  )) {
    identifiers.add(match[1]);
  }
}

function extractNamespaceImports(
  content: string,
  identifiers: Set<string>,
): void {
  for (const match of content.matchAll(
    /\bimport\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from/g,
  )) {
    identifiers.add(match[1]);
  }
}

function extractNamedImports(
  content: string,
  identifiers: Set<string>,
): void {
  for (const match of content.matchAll(/\bimport\s*\{([^}]+)\}\s*from/g)) {
    for (const specifier of match[1].split(",")) {
      const identifier = specifier
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)
        .pop();
      if (identifier && /^[A-Za-z_$][\w$]*$/.test(identifier)) {
        identifiers.add(identifier);
      }
    }
  }
}

function extractCommonJsImports(
  content: string,
  identifiers: Set<string>,
): void {
  for (const match of content.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(/g,
  )) {
    identifiers.add(match[1]);
  }
  for (const match of content.matchAll(
    /\b(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\s*\(/g,
  )) {
    for (const specifier of match[1].split(",")) {
      const identifier = specifier.trim().split(/\s*:\s*/).pop();
      if (identifier && /^[A-Za-z_$][\w$]*$/.test(identifier)) {
        identifiers.add(identifier);
      }
    }
  }
}

function extractDeclaredIdentifiers(content: string): string[] {
  const identifiers = new Set<string>();
  const pattern =
    /\b(?:class|function|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  for (const match of content.matchAll(pattern)) identifiers.add(match[1]);
  return Array.from(identifiers);
}

function normalizeShellCommand(value: string): string {
  return value
    .trim()
    .replace(/^\$\s+/, "")
    .replace(/\s+#.*$/, "")
    .replace(/\s+/g, " ");
}

function isInstallCommand(command: string): boolean {
  const withoutPrivilegePrefix = command.replace(
    /^(?:sudo|doas)\s+/i,
    "",
  );
  return INSTALL_COMMAND_PATTERNS.some((pattern) =>
    pattern.test(withoutPrivilegePrefix),
  );
}
