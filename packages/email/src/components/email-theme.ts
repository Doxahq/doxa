/**
 * Design tokens for every Doxa email. Emails use inline styles and a light
 * card, because many email clients drop `<style>` blocks and force light mode.
 * The accent is the dashboard primary (`--dashboard-primary` in apps/web).
 */
export const emailTheme = {
  color: {
    page: "#f4f4f5",
    card: "#ffffff",
    border: "#e4e4e7",
    text: "#18181b",
    muted: "#71717a",
    accent: "#3d8bff",
    accentText: "#ffffff",
  },
  font: {
    sans: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
    mono: "'JetBrains Mono', SFMono-Regular, Menlo, Consolas, monospace",
  },
  size: {
    cardWidth: 520,
  },
} as const;

/** The product name and site, shown in the header and footer of each email. */
export const emailBrand = {
  name: "Doxa",
  url: "https://doxa.so",
  /**
   * The logo mark for light backgrounds (`#1A1A18`), as a PNG: Gmail and
   * Outlook do not show SVG. Served by apps/web from
   * `public/email/doxa-logo-mark.png` (80 x 97, drawn at 20 x 24). Sent
   * emails keep this URL forever: never move or delete the file.
   */
  logo: {
    url: "https://doxa.so/email/doxa-logo-mark.png",
    width: 20,
    height: 24,
  },
} as const;
