import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

import { workspaceSourceAliases } from "./src/config/vite/workspace-aliases";

export default defineConfig({
  resolve: {
    alias: [
      ...workspaceSourceAliases,
      {
        find: "@",
        replacement: fileURLToPath(new URL(".", import.meta.url)),
      },
      {
        find: "~",
        replacement: fileURLToPath(new URL("./src", import.meta.url)),
      },
    ],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
  },
});
