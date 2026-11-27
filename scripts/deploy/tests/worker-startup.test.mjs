import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = new URL("../", import.meta.url);

/** Workers whose health route answers JSON with their service name. */
const JSON_HEALTH_SERVICES = {
  "agent-worker": "doxa-agent-worker",
  "email-worker": "doxa-email",
};

for (const app of ["docs-runtime", "agent-worker", "email-worker"]) {
  test(`${app} starts with its configured compatibility flags`, {
    timeout: 30_000,
  }, async () => {
    const directory = new URL(`apps/${app}/`, root);
    const config = JSON.parse(
      await readFile(new URL("wrangler.json", directory), "utf8"),
    );
    // Use the app's installed Wrangler toolchain, not a second runtime version.
    const requireApp = createRequire(new URL("package.json", directory));
    const requireWrangler = createRequire(
      requireApp.resolve("wrangler/package.json"),
    );
    const { build } = requireWrangler("esbuild");
    const { Miniflare } = requireWrangler("miniflare");
    const bundle = await build({
      entryPoints: [fileURLToPath(new URL(config.main, directory))],
      absWorkingDir: fileURLToPath(root),
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2022",
      external: ["node:*", "cloudflare:*"],
    });
    const runtime = new Miniflare({
      name: config.name,
      modules: [{
        type: "ESModule",
        path: "worker.mjs",
        contents: bundle.outputFiles[0].text,
      }],
      compatibilityDate: config.compatibility_date,
      compatibilityFlags: config.compatibility_flags ?? [],
      // The docs-runtime landing page is a local preview only (SEC-022); the
      // local wrangler vars turn it on.
      bindings: app === "docs-runtime"
        ? { DOCS_RUNTIME_HTML_PREVIEW: config.vars?.DOCS_RUNTIME_HTML_PREVIEW ?? "" }
        : {},
      host: "127.0.0.1",
      port: 0,
      outboundService: () => {
        throw new Error("Startup checks must not make external requests.");
      },
    });
    try {
      await runtime.ready;
      const response = await runtime.dispatchFetch("http://startup.test/");
      assert.equal(response.status, 200);
      if (app in JSON_HEALTH_SERVICES) {
        assert.deepEqual(await response.json(), {
          ok: true,
          service: JSON_HEALTH_SERVICES[app],
        });
      } else {
        assert.match(response.headers.get("content-type"), /text\/html/);
        assert.match(await response.text(), /Doxa/);
      }
    } finally {
      await runtime.dispose();
    }
  });
}
