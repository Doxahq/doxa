import { THEME_PRESETS, type ThemePreset } from "./presets";
import { THEME_TOKEN_CSS_VARIABLES } from "./tokens";
import { themeSchema, type ResolvedTheme } from "./schema/theme";
import { fontDefinition } from "./primitives/font-family";

function tokenDeclarations(
  tokens: Readonly<Record<string, string | undefined>>,
): string {
  return Object.entries(THEME_TOKEN_CSS_VARIABLES)
    .map(([key, variable]) => `${variable}: ${tokens[key]}`)
    .join("; ");
}

function fontVariables(theme: ResolvedTheme) {
  return {
    "--font-body":
      fontDefinition(theme.fonts.body)?.css ?? "system-ui, sans-serif",
    "--font-code":
      fontDefinition(theme.fonts.code)?.css ?? "ui-monospace, monospace",
  } as const;
}

function generateCss(theme: ResolvedTheme): string {
  const fonts = fontVariables(theme);
  const fontVars = `--font-body: ${fonts["--font-body"]}; --font-code: ${fonts["--font-code"]}`;
  const parts =
    theme.colorMode === "dark-only"
      ? [
          `:root, .dark { ${tokenDeclarations(theme.tokens.light)}; ${fontVars} }`,
        ]
      : [
          `:root { ${tokenDeclarations(theme.tokens.light)}; ${fontVars} }`,
          `.dark { ${tokenDeclarations(theme.tokens.dark)} }`,
        ];
  const preset: ThemePreset = THEME_PRESETS[theme.preset];
  if (preset.extraCss) parts.push(preset.extraCss);
  return parts.join("\n");
}

export function themeToCss(theme: ResolvedTheme): string {
  const css = generateCss(theme);
  if (!css.includes("<")) return css;
  console.warn("site_config_css_rejected");
  return generateCss(themeSchema.parse({}));
}

/**
 * The theme's CSS variables for one color mode, as a name to value map.
 *
 * An editor sets these on one element through the CSSOM (a React `style`
 * object), so a page region takes the site's look without a stylesheet
 * string. A dark-only theme keeps its one token set in both modes.
 */
export function themeCssVariables(
  theme: ResolvedTheme,
  mode: "light" | "dark",
): Record<`--${string}`, string> {
  const tokens =
    mode === "dark" && theme.colorMode !== "dark-only"
      ? theme.tokens.dark
      : theme.tokens.light;
  const variables: Record<`--${string}`, string> = { ...fontVariables(theme) };
  for (const [key, variable] of Object.entries(THEME_TOKEN_CSS_VARIABLES)) {
    const value = (tokens as Readonly<Record<string, string | undefined>>)[key];
    if (value !== undefined) variables[variable] = value;
  }
  return variables;
}

/** At-rules whose body holds ordinary style rules that must be scoped too. */
const GROUPING_AT_RULE = /^@(media|supports|container|layer)\b/;

/**
 * Puts every style rule of a stylesheet under one selector.
 *
 * The input is preset CSS written in this package, not user input, so a small
 * brace walk is enough. `:root`, `html` and `body` become the scope itself.
 * Other at-rules (`@keyframes`, `@font-face`) are kept as they are.
 */
export function scopeCss(css: string, scope: string): string {
  const rules: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < css.length; index += 1) {
    const char = css[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        rules.push(css.slice(start, index + 1).trim());
        start = index + 1;
      }
    }
  }
  return rules
    .filter(Boolean)
    .map((rule) => {
      const open = rule.indexOf("{");
      const prelude = rule.slice(0, open).trim();
      const body = rule.slice(open + 1, -1);
      if (prelude.startsWith("@")) {
        return GROUPING_AT_RULE.test(prelude)
          ? `${prelude} { ${scopeCss(body, scope)} }`
          : rule;
      }
      const selectors = prelude
        .split(",")
        .map((selector) => scopeSelector(selector.trim(), scope));
      return `${selectors.join(", ")} {${body}}`;
    })
    .join("\n");
}

function scopeSelector(selector: string, scope: string): string {
  const root = /^(:root|html|body)\b/.exec(selector);
  if (root) return `${scope}${selector.slice(root[0].length)}`;
  return `${scope} ${selector}`;
}
