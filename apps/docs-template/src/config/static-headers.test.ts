import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

// Vite copies `public/` into `dist/client`, the dispatcher's static assets
// directory. Those responses never run the dispatcher (spec 3.1, F28).
const headers = readFileSync(
  new URL("../../public/_headers", import.meta.url),
  "utf8"
);

describe("static asset headers", () => {
  test("send a one-day HSTS header on every static asset", () => {
    const rules = headers
      .split("\n")
      .filter((line) => line.trim() && !line.trim().startsWith("#"));
    expect(rules).toEqual(["/*", "  Strict-Transport-Security: max-age=86400"]);
  });
});
