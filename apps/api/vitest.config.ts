import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    server: {
      deps: {
        // The provider imports `cloudflare:workers`, which only exists in
        // workerd. Inlining it lets a test's vi.mock of that module apply.
        inline: ["@cloudflare/workers-oauth-provider"],
      },
    },
  },
});
