import { describe, expect, test } from "vitest";
import { normalizeDocsHostname } from "../../src/utils/hostname";

describe("normalizeDocsHostname", () => {
  test.each([
    ["Docs.Example.COM", "docs.example.com"],
    [" docs.example.com. ", "docs.example.com"],
    ["docs.example.com:443", "docs.example.com"],
    ["https://Docs.Example.com/docs", "docs.example.com"],
    ["localhost", "localhost"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeDocsHostname(input)).toBe(expected);
  });

  test.each([
    "",
    "docs..example.com",
    "-docs.example.com",
    "docs-.example.com",
    "docs_example.com",
    "https://",
  ])("rejects invalid hostname %s", (input) => {
    expect(normalizeDocsHostname(input)).toBeNull();
  });
});
