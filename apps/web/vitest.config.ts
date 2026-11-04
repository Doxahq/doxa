import { defineConfig } from "vitest/config"
import { fileURLToPath } from "node:url"

import { collaborationStubAlias } from "./config/collaboration-stub-alias"

export default defineConfig({
  resolve: {
    // The tests run the editor with the same collaboration stub as the app.
    alias: [{ find: "~", replacement: fileURLToPath(new URL("./src", import.meta.url)) }, ...collaborationStubAlias],
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}"],
    // No prefix, as in production, whatever `.env.local` sets for development.
    env: { VITE_AUTH_COOKIE_PREFIX: "" },
    // Node would load the drag handle's own imports and skip the alias above.
    server: { deps: { inline: ["@tiptap/extension-drag-handle"] } },
  },
})
