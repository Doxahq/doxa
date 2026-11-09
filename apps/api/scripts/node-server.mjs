#!/usr/bin/env node
// Builds and runs the API as a Node server (the origin behind the thin
// doxa-api Worker).
//
//   node scripts/node-server.mjs build   bundle to dist-node/server.mjs
//   node scripts/node-server.mjs dev     bundle on every change and restart the server
//
// `dev` runs the origin as `pnpm dev --api-node` needs it: on :8786, behind
// the thin Worker on :8787, with Valkey on :6379 and the local R2 state that
// the other dev Workers use. It reads the two shared keys from
// apps/api-edge/.dev.vars. Variables set in the shell win.
//
// The bundle holds every dependency except Wrangler, which only the local
// docs bucket of `dev` loads, and sharp, which is native code. `build` copies
// sharp to dist-node/node_modules. `cloudflare:workers` resolves to a small shim.

import { spawn } from "node:child_process";
import { cpSync, existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import * as esbuild from "esbuild";

const appRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(appRoot, "../..");
const outdir = path.join(appRoot, "dist-node");
const outfile = path.join(outdir, "server.mjs");

/** @type {import("esbuild").BuildOptions} */
const buildOptions = {
  entryPoints: {
    server: path.join(appRoot, "src/runtime/node/main.ts"),
    "image-worker-child": path.join(appRoot, "src/runtime/node/image-processing/child.ts"),
  },
  outdir,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  sourcemap: "linked",
  legalComments: "none",
  alias: { "cloudflare:workers": path.join(appRoot, "src/runtime/node/workers-shim.ts") },
  // Wrangler: dev only. pg-native: an optional pg driver that the server does not use.
  // sharp: native code, which a bundle cannot hold.
  external: ["wrangler", "pg-native", "sharp"],
  // CommonJS dependencies call require(); ESM output has none by default.
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  logLevel: "warning",
};

const command = process.argv[2];

if (command === "build") {
  await esbuild.build(buildOptions);
  rmSync(path.join(outdir, "node_modules"), { recursive: true, force: true });
  copyInstalledPackage("sharp", path.join(appRoot, "node_modules"));
  console.log(`[node-server] Built ${path.relative(process.cwd(), outfile)}`);
} else if (command === "dev") {
  await runDev();
} else {
  console.error("Usage: node scripts/node-server.mjs build|dev");
  process.exit(1);
}

/**
 * Copies a package and its dependencies, as the lockfile installed them. An
 * optional dependency for another platform is not on disk, so it is skipped.
 */
function copyInstalledPackage(name, fromModules, copied = new Set()) {
  const link = path.join(fromModules, name);
  if (copied.has(name) || !existsSync(link)) return;
  copied.add(name);
  const directory = realpathSync(link);
  cpSync(directory, path.join(outdir, "node_modules", name), { recursive: true });
  const { dependencies = {}, optionalDependencies = {} } = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
  // pnpm puts a package's dependencies beside it.
  const siblings = directory.slice(0, -name.length - 1);
  for (const dependency of Object.keys({ ...dependencies, ...optionalDependencies })) {
    copyInstalledPackage(dependency, siblings, copied);
  }
}

/** Settings of the local origin. The shell environment overrides them. */
function devEnvironment() {
  return {
    PORT: "8786",
    BRIDGE_URL: "http://localhost:8787",
    VALKEY_URL: "redis://localhost:6379",
    DOCS_BUCKET_SOURCE: "local",
    WRANGLER_CONFIG_PATH: path.join(appRoot, "wrangler.json"),
    WRANGLER_PERSIST_PATH: path.join(repoRoot, ".wrangler/state/v3"),
    // As in `wrangler dev`, which has no global_fetch_strictly_public flag.
    STRICT_PUBLIC_FETCH: "false",
    SHUTDOWN_GRACE_MS: "5000",
    ...readDevVars(path.join(repoRoot, "apps/api-edge/.dev.vars"), ["ORIGIN_SHARED_SECRET", "BRIDGE_SHARED_SECRET"]),
    ...process.env,
  };
}

/** Reads `names` from a .dev.vars file. Fails when the file or a name is missing. */
function readDevVars(file, names) {
  if (!existsSync(file)) {
    console.error(`[node-server] ${path.relative(repoRoot, file)} is missing. Run pnpm dev --api-node once, or copy apps/api-edge/.dev.vars.example.`);
    process.exit(1);
  }
  const values = Object.fromEntries(
    readFileSync(file, "utf8")
      .split("\n")
      .map((line) => /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()))
      .filter((match) => match !== null)
      .map((match) => [match[1], match[2]]),
  );
  for (const name of names) {
    if (!values[name]) {
      console.error(`[node-server] ${name} is missing in ${path.relative(repoRoot, file)}.`);
      process.exit(1);
    }
  }
  return Object.fromEntries(names.map((name) => [name, values[name]]));
}

async function runDev() {
  const env = devEnvironment();
  let child = null;

  const restart = () => {
    const start = () => {
      child = spawn(process.execPath, ["--enable-source-maps", outfile], { stdio: "inherit", env });
      child.on("exit", (code, signal) => {
        if (signal === null && code !== 0) console.error(`[node-server] Exited with code ${code}. Waiting for a change.`);
      });
    };
    if (!child || child.exitCode !== null || child.signalCode !== null) return start();
    child.once("exit", start);
    child.kill("SIGTERM");
  };

  const context = await esbuild.context({
    ...buildOptions,
    plugins: [
      {
        name: "restart-on-build",
        setup(build) {
          build.onEnd((result) => {
            if (result.errors.length === 0) restart();
          });
        },
      },
    ],
  });
  await context.watch();

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, async () => {
      await context.dispose();
      child?.kill(signal);
      process.exit(0);
    });
  }
}
