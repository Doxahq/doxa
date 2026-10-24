import { describe, expect, it } from "vitest";
import {
  resolveSiteConfig,
  toEditableSiteConfig,
  THEME_PRESETS,
} from "../src";

describe("editable site config", () => {
  it.each(Object.keys(THEME_PRESETS))(
    "reduces the %s preset to no token overrides",
    (preset) => {
      const editable = toEditableSiteConfig(
        resolveSiteConfig({ theme: { preset } }),
      );
      expect(editable.theme.tokens).toEqual({ light: {}, dark: {} });
      expect(editable.theme.radius).toBeUndefined();
      expect(editable.theme.colorMode).toBeUndefined();
      expect(editable.theme.fonts).toEqual({});
    },
  );

  it("keeps only the values that differ from the chosen preset", () => {
    const editable = toEditableSiteConfig(
      resolveSiteConfig({
        theme: {
          preset: "brutalist",
          primary: "#3b82f6",
          radius: "4px",
          fonts: { body: "Inter" },
          tokens: { dark: { codeBg: "#101010" } },
        },
      }),
    );
    expect(editable.theme).toMatchObject({
      preset: "brutalist",
      primary: "#3b82f6",
      radius: "4px",
      fonts: { body: "Inter" },
      tokens: { light: {}, dark: { codeBg: "#101010" } },
    });
  });

  it.each([
    {},
    { theme: { preset: "brutalist" } },
    { theme: { primary: "oklch(0.6 0.2 30)", radius: "2px" } },
    {
      theme: {
        defaultMode: "dark",
        colorMode: "dark-only",
        fonts: { code: "Fira Code" },
        tokens: { light: { background: "#fafafa" }, dark: { radius: "8px" } },
      },
    },
  ] as const)("resolves back to the same config (%#)", (input) => {
    const resolved = resolveSiteConfig(input);
    expect(resolveSiteConfig(toEditableSiteConfig(resolved))).toEqual(resolved);
  });

  it("lets a preset change reach the tokens after a round trip", () => {
    const editable = toEditableSiteConfig(resolveSiteConfig({}));
    const switched = resolveSiteConfig({
      ...editable,
      theme: { ...editable.theme, preset: "brutalist" },
    });
    expect(switched.theme.tokens.light.background).toBe(
      THEME_PRESETS.brutalist.light.background,
    );
  });

  it("lets a primary color change reach the tokens after a round trip", () => {
    const editable = toEditableSiteConfig(resolveSiteConfig({}));
    const changed = resolveSiteConfig({
      ...editable,
      theme: { ...editable.theme, primary: "#ff0000" },
    });
    expect(changed.theme.tokens.light.primary).toBe("#ff0000");
    expect(changed.theme.tokens.dark.primary).toBe("#ff0000");
  });
});
