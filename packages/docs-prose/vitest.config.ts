import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@doxahq/mdx-runtime": fileURLToPath(
        new URL("../mdx-runtime/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
  },
});
