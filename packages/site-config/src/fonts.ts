import type { ResolvedTheme } from "./schema/theme";

export const FONT_CATALOG = {
  Inter: {
    family: "Inter",
    weights: "400;500;600;700",
    css: '"Inter", system-ui, -apple-system, sans-serif',
  },
  "JetBrains Mono": {
    family: "JetBrains+Mono",
    weights: "400;500;600;700;800",
    css: '"JetBrains Mono", "Fira Code", ui-monospace, monospace',
  },
  Sora: {
    family: "Sora",
    weights: "400;600;700",
    css: '"Sora", system-ui, sans-serif',
  },
  "Fira Code": {
    family: "Fira+Code",
    weights: "400;500;600;700",
    css: '"Fira Code", ui-monospace, monospace',
  },
  "system-ui": {
    family: null,
    weights: "",
    css: "system-ui, -apple-system, sans-serif",
  },
  "ui-monospace": { family: null, weights: "", css: "ui-monospace, monospace" },
} as const;

export function fontStylesheetHref(theme: ResolvedTheme): string | null {
  const families = new Set<string>();
  for (const name of [theme.fonts.body, theme.fonts.code]) {
    const font = Object.entries(FONT_CATALOG).find(
      ([family]) => family === name,
    )?.[1];
    if (font?.family)
      families.add(`family=${font.family}:wght@${font.weights}`);
  }
  return families.size
    ? `https://fonts.googleapis.com/css2?${[...families].sort().join("&")}&display=swap`
    : null;
}
