import { describe, expect, it, vi } from "vitest";
import {
  fontStylesheetHref,
  resolveSiteConfig,
  scopeCss,
  themeCssVariables,
  themeToCss,
  THEME_TOKEN_CSS_VARIABLES,
  THEME_PRESETS,
  hashSiteConfig,
} from "../src";

describe("safe theme output", () => {
  it("keeps explicit per-mode tokens when resolved config is read again", () => {
    const config = resolveSiteConfig({
      theme: {
        primary: "#abcdef",
        radius: "2px",
        tokens: {
          light: { radius: "4px" },
          dark: { primary: "#123456", radius: "8px" },
        },
      },
    });
    expect(config.theme.tokens.light.radius).toBe("4px");
    expect(config.theme.tokens.dark.radius).toBe("8px");
    expect(config.theme.tokens.dark.primary).toBe("#123456");
    expect(resolveSiteConfig(config)).toEqual(config);
  });
  it.each(Object.keys(THEME_PRESETS))(
    "preserves preset CSS for %s",
    (preset) => {
      expect(
        themeToCss(resolveSiteConfig({ theme: { preset } }).theme),
      ).toMatchSnapshot();
    },
  );
  it("applies primary and radius overrides to both modes", () => {
    const config = resolveSiteConfig({
      theme: { primary: "#abcdef", radius: "2px" },
    });
    for (const mode of [config.theme.tokens.light, config.theme.tokens.dark]) {
      expect(mode.primary).toBe("#abcdef");
      expect(mode.radius).toBe("2px");
    }
  });
  it("resolves deterministic random tokens only to known declarations", () => {
    let seed = 1977;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed;
    };
    for (let iteration = 0; iteration < 100; iteration++) {
      const tokens = Object.fromEntries(
        Object.keys(THEME_TOKEN_CSS_VARIABLES).map((key) => [
          key,
          key === "radius"
            ? `${random() % 65}px`
            : `#${(random() % 0xffffff).toString(16).padStart(6, "0")}`,
        ]),
      );
      const css = themeToCss(
        resolveSiteConfig({
          theme: { tokens: { light: tokens, dark: tokens } },
        }).theme,
      );
      expect(css).not.toContain("<");
      const declarations = css.match(/--[\w-]+: [^;}]+/g) ?? [];
      const allowed = new Set<string>([
        ...Object.values(THEME_TOKEN_CSS_VARIABLES),
        "--font-body",
        "--font-code",
      ]);
      expect(declarations.length).toBeGreaterThan(70);
      for (const declaration of declarations) {
        expect(allowed.has(declaration.split(":", 1)[0])).toBe(true);
        expect(declaration).toMatch(/^--[a-z0-9-]+: .+$/);
      }
    }
  });
  it("returns default CSS if the second barrier detects a style terminator", () => {
    const theme = resolveSiteConfig({}).theme;
    theme.tokens.light.background = "</style>";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(themeToCss(theme)).toBe(themeToCss(resolveSiteConfig({}).theme));
    expect(warn).toHaveBeenCalledWith("site_config_css_rejected");
    warn.mockRestore();
  });
  it("builds font URLs only from curated values and skips system fonts", () => {
    const theme = resolveSiteConfig({}).theme;
    expect(fontStylesheetHref(theme)).toBe(
      "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700;800&display=swap",
    );
    const system = resolveSiteConfig({
      theme: { fonts: { body: "system-ui", code: "ui-monospace" } },
    }).theme;
    expect(fontStylesheetHref(system)).toBeNull();
  });
  it("hashes canonical config independently of property insertion order", async () => {
    const first = resolveSiteConfig({ name: "Docs", description: "A site" });
    const second = resolveSiteConfig({ description: "A site", name: "Docs" });
    expect(await hashSiteConfig(first)).toMatch(/^[a-f0-9]{64}$/);
    expect(await hashSiteConfig(first)).toBe(await hashSiteConfig(second));
    expect(await hashSiteConfig(first)).not.toBe(
      await hashSiteConfig(resolveSiteConfig({ name: "Other" })),
    );
  });
});

describe("theme CSS variables", () => {
  it("returns every token and both font variables for the chosen mode", () => {
    const theme = resolveSiteConfig({
      theme: { tokens: { light: { background: "#ffffff" }, dark: { background: "#000000" } } },
    }).theme;
    const light = themeCssVariables(theme, "light");
    const dark = themeCssVariables(theme, "dark");
    expect(light["--background"]).toBe("#ffffff");
    expect(dark["--background"]).toBe("#000000");
    expect(Object.keys(light).sort()).toEqual(
      [...Object.values(THEME_TOKEN_CSS_VARIABLES), "--font-body", "--font-code"].sort(),
    );
    expect(light["--font-body"]).toContain("Inter");
  });

  it("keeps the one token set of a dark-only theme in both modes", () => {
    const theme = resolveSiteConfig({ theme: { preset: "brutalist" } }).theme;
    expect(theme.colorMode).toBe("dark-only");
    expect(themeCssVariables(theme, "light")).toEqual(themeCssVariables(theme, "dark"));
  });

  it("matches the values the published stylesheet declares", () => {
    const theme = resolveSiteConfig({}).theme;
    const css = themeToCss(theme);
    for (const [name, value] of Object.entries(themeCssVariables(theme, "light"))) {
      expect(css).toContain(`${name}: ${value}`);
    }
  });
});

describe("scopeCss", () => {
  it("maps root selectors to the scope and prefixes the others", () => {
    expect(scopeCss(":root { a: b } html, .x .y { c: d }", ".s")).toBe(
      ".s { a: b }\n.s, .s .x .y { c: d }",
    );
  });

  it("scopes rules inside media blocks and keeps keyframes as they are", () => {
    expect(
      scopeCss(
        "@media (min-width: 1px) { .a { b: c } } @keyframes k { from { o: 0 } }",
        ".s",
      ),
    ).toBe("@media (min-width: 1px) { .s .a { b: c } }\n@keyframes k { from { o: 0 } }");
  });
});
