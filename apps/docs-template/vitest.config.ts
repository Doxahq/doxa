import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@doxahq/mdx-runtime/highlight": fileURLToPath(
        new URL(
          "../../packages/mdx-runtime/src/highlight/index.ts",
          import.meta.url
        )
      ),
      "@doxahq/mdx-runtime": fileURLToPath(
        new URL("../../packages/mdx-runtime/src/index.ts", import.meta.url)
      ),
      "@": fileURLToPath(new URL(".", import.meta.url)),
      "~": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
  },
});
