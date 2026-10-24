import { describe, expect, test } from "vitest";

import {
  encodeGenerationCursor,
  parseGenerationPageRequest,
} from "../../src/utils/generation-pagination";

describe("generation pagination", () => {
  test("uses the default page size when pagination is omitted", () => {
    const result = parseGenerationPageRequest(
      new URL("https://api.doxa.so/projects/project-1/generations"),
    );

    expect(result).toEqual({
      ok: true,
      value: { limit: 20, cursor: null },
    });
  });

  test("clamps the requested page size to the supported range", () => {
    const maximum = parseGenerationPageRequest(
      new URL("https://api.doxa.so/projects/project-1/generations?limit=200"),
    );
    const minimum = parseGenerationPageRequest(
      new URL("https://api.doxa.so/projects/project-1/generations?limit=0"),
    );

    expect(maximum).toEqual({
      ok: true,
      value: { limit: 50, cursor: null },
    });
    expect(minimum).toEqual({
      ok: true,
      value: { limit: 1, cursor: null },
    });
  });

  test("rejects non-integer limits", () => {
    const result = parseGenerationPageRequest(
      new URL("https://api.doxa.so/projects/project-1/generations?limit=2.5"),
    );

    expect(result).toEqual({
      ok: false,
      message: "Invalid generation page limit.",
    });
  });

  test("rejects malformed cursors without exposing their contents", () => {
    const result = parseGenerationPageRequest(
      new URL("https://api.doxa.so/projects/project-1/generations?cursor=not-a-cursor"),
    );

    expect(result).toEqual({
      ok: false,
      message: "Invalid generation cursor.",
    });
  });

  test("rejects oversized cursors before decoding", () => {
    const result = parseGenerationPageRequest(
      new URL(`https://api.doxa.so/projects/project-1/generations?cursor=${"a".repeat(513)}`),
    );

    expect(result).toEqual({
      ok: false,
      message: "Invalid generation cursor.",
    });
  });

  test("round-trips a validated cursor position", () => {
    const cursor = encodeGenerationCursor({
      createdAt: "2026-07-18T12:34:56.123456Z",
      id: "11111111-1111-4111-8111-111111111111",
    });

    const result = parseGenerationPageRequest(
      new URL(`https://api.doxa.so/projects/project-1/generations?cursor=${cursor}`),
    );

    expect(result).toEqual({
      ok: true,
      value: {
        limit: 20,
        cursor: {
          createdAt: "2026-07-18T12:34:56.123456Z",
          id: "11111111-1111-4111-8111-111111111111",
        },
      },
    });
  });
});
