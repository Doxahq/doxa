import { describe, expect, it } from "vitest";
import {
  cssColorSchema,
  cssLengthSchema,
  assetRefSchema,
  fontFamilySchema,
  hrefSchema,
  socialHrefSchema,
  plainTextSchema,
} from "../src";

// Section 6.1: each payload runs against both CSS primitives.
const attacks = [
  ";",
  "{",
  "}",
  "<",
  ">",
  "\\",
  "/*",
  "url(https://evil.test)",
  "image-set(url(https://evil.test))",
  "expression(alert(1))",
  "@import 'evil'",
  "var(--untrusted)",
  "\\75rl(https://evil.test)",
  "ｒｇｂ(1 2 3)",
  "#fff; color: red",
  "0}body{display:none}",
  "</style><script>alert(1)</script>",
  "#fff\n",
  "1rem\n",
  "rgb(1 2 3)\r\n",
  "a".repeat(65),
];

describe("CSS allowlists", () => {
  it.each(attacks)("rejects attack %j in both primitives", (value) => {
    expect(cssColorSchema.safeParse(value).success).toBe(false);
    expect(cssLengthSchema.safeParse(value).success).toBe(false);
  });
  it.each([
    "#abc",
    "#abcd",
    "#AABBCC",
    "#aabbccdd",
    "rgb(0 255 20)",
    "rgba(0, 255, 20, 0.5)",
    "rgb(0% 100% 50% / 75%)",
    "hsl(360 100% 0%)",
    "hsla(0deg, 10%, 20%, .5)",
    "hsl(-180deg 50% 50% / 1)",
    "oklch(1 0.4 360 / 0.5)",
    "oklab(0.5 -0.4 0.4)",
    "oklab(100% -100% 100% / 100%)",
  ])("accepts bounded color %s", (value) =>
    expect(cssColorSchema.safeParse(value).success).toBe(true),
  );
  it.each([
    "red",
    "transparent",
    "rgb(256 0 0)",
    "rgb(-1 0 0)",
    "rgb(0 0 0 / 1.1)",
    "hsl(361 10% 20%)",
    "hsl(0 101% 20%)",
    "oklch(1.1 0.2 0)",
    "oklch(0.5 0.41 0)",
    "oklab(0.5 -0.41 0)",
    "rgb(NaN 0 0)",
    "rgb(Infinity 0 0)",
    "rgb(1e2 0 0)",
    "#12",
    " #fff",
  ])("rejects unbounded or unsupported color %s", (value) =>
    expect(cssColorSchema.safeParse(value).success).toBe(false),
  );
  it.each(["0", "0rem", ".5rem", "4rem", "0px", "64px"])(
    "accepts length %s",
    (value) => {
      expect(cssLengthSchema.safeParse(value).success).toBe(true);
    },
  );
  it.each(["-1px", "4.01rem", "64.1px", "1em", "1%", "1", "calc(1px + 1px)"])(
    "rejects length %s",
    (value) => {
      expect(cssLengthSchema.safeParse(value).success).toBe(false);
    },
  );
});

describe("links and resource references", () => {
  it.each([
    "javascript:alert(1)",
    "data:text/html,hi",
    "vbscript:foo",
    "file:///tmp/x",
    "//evil.test",
    "guide",
    "/\\evil",
    "/a b",
    "/a\tb",
    "https://a.test/\nx",
    "ｈttps://evil.test",
    "x".repeat(2049),
  ])("rejects unsafe link %j", (value) =>
    expect(hrefSchema.safeParse(value).success).toBe(false),
  );
  it.each([
    "/",
    "/guide",
    "https://example.com/path?q=1",
    "http://example.com",
    "mailto:hello@example.com",
  ])("accepts link %s", (value) =>
    expect(hrefSchema.safeParse(value).success).toBe(true),
  );
  it("uses the existing internal route normalization", () => {
    expect(hrefSchema.parse("/guide/index.mdx?x=1#heading")).toBe("/guide");
    expect(hrefSchema.parse("/index")).toBe("/");
  });
  it("permits only HTTPS social links", () => {
    expect(socialHrefSchema.safeParse("https://example.com").success).toBe(
      true,
    );
    for (const value of ["http://example.com", "mailto:a@b.com", "/guide"]) {
      expect(socialHrefSchema.safeParse(value).success).toBe(false);
    }
  });
  it("accepts only lowercase SHA-256 asset references", () => {
    expect(assetRefSchema.safeParse(`asset:${"a".repeat(64)}`).success).toBe(
      true,
    );
    for (const value of [
      "https://evil.test/logo.svg",
      "data:image/svg+xml,x",
      `asset:${"A".repeat(64)}`,
      `asset:${"a".repeat(63)}`,
      `asset:${"a".repeat(64)}\n`,
    ]) {
      expect(assetRefSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe("text and fonts", () => {
  it("trims text and checks size and control characters", () => {
    expect(plainTextSchema(4).parse("  docs  ")).toBe("docs");
    for (const value of ["12345", "a\u0000", "a\n", "a\u007f", "a\u0085"]) {
      expect(plainTextSchema(4).safeParse(value).success).toBe(false);
    }
  });
  it("rejects fonts outside the allowlist", () => {
    expect(fontFamilySchema.safeParse("Inter").success).toBe(true);
    for (const value of [
      "Unknown",
      "Inter; color:red",
      "url(https://evil.test/font)",
      "constructor",
      "__proto__",
    ]) {
      expect(fontFamilySchema.safeParse(value).success).toBe(false);
    }
  });
});
