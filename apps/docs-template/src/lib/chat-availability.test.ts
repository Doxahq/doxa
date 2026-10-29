import { describe, expect, it } from "vitest";

import { isChatAvailable } from "./chat-availability";

describe("isChatAvailable", () => {
  it("keeps chat in the template's own build", () => {
    expect(isChatAvailable({ ai: { chat: true } }, false)).toBe(true);
  });

  it("hides chat in the platform renderer build", () => {
    expect(isChatAvailable({ ai: { chat: true } }, true)).toBe(false);
  });

  it("hides chat when the site turns it off", () => {
    expect(isChatAvailable({ ai: { chat: false } }, false)).toBe(false);
  });

  it("reads the build flag by default", () => {
    // The test build is not the platform renderer build.
    expect(isChatAvailable({ ai: { chat: true } })).toBe(true);
  });
});
