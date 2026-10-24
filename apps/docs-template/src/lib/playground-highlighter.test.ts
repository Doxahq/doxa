import { describe, expect, test } from "vitest";

import { loadPlaygroundHighlighter } from "./playground-highlighter";

describe("playground highlighter loader", () => {
  test("reuses one lazy highlighter load across playgrounds", async () => {
    const firstLoad = loadPlaygroundHighlighter();
    const secondLoad = loadPlaygroundHighlighter();

    expect(secondLoad).toBe(firstLoad);
    await expect(firstLoad).resolves.toBe(await secondLoad);
  });
});
