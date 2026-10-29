import { describe, expect, test } from "vitest";

import { utf8ByteLength } from "./utf8";

describe("utf8ByteLength", () => {
  test("matches TextEncoder", () => {
    for (const value of [
      "",
      "ascii",
      "é",
      "日本語",
      "😀 emoji",
      "\ud800 lone",
    ]) {
      expect(utf8ByteLength(value)).toBe(
        new TextEncoder().encode(value).length
      );
    }
  });
});
