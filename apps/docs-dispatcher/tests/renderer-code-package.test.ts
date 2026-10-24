import { describe, expect, test } from "vitest";

import { parseRendererCodePackage } from "../src/renderer-code-package";

describe("parseRendererCodePackage", () => {
  test("accepts an immutable renderer module package", () => {
    const code = parseRendererCodePackage(
      JSON.stringify({
        schemaVersion: 1,
        buildId: "build-1",
        compatibilityDate: "2026-06-12",
        compatibilityFlags: ["nodejs_compat"],
        mainModule: "index.js",
        modules: {
          "index.js": "export default { fetch() {} }",
          "assets/chunk.js": "export const value = 1;",
        },
      }),
      "build-1",
    );

    expect(code.mainModule).toBe("index.js");
    expect(code.modules).toHaveProperty("assets/chunk.js");
  });

  test("rejects a package whose build ID does not match the deployment", () => {
    expect(() =>
      parseRendererCodePackage(
        JSON.stringify({
          schemaVersion: 1,
          buildId: "other-build",
          compatibilityDate: "2026-06-12",
          compatibilityFlags: [],
          mainModule: "index.js",
          modules: { "index.js": "export default {}" },
        }),
        "build-1",
      ),
    ).toThrow("build ID");
  });

  test("rejects packages with a missing main module", () => {
    expect(() =>
      parseRendererCodePackage(
        JSON.stringify({
          schemaVersion: 1,
          buildId: "build-1",
          compatibilityDate: "2026-06-12",
          compatibilityFlags: [],
          mainModule: "index.js",
          modules: { "other.js": "export default {}" },
        }),
        "build-1",
      ),
    ).toThrow("main module");
  });
});
