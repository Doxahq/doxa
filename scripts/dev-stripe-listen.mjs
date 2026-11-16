#!/usr/bin/env node
// Forwards Stripe sandbox webhooks to the local API (docs/billing/spec.md 20.5).
//
//   pnpm dev:stripe                 forward to http://localhost:8787
//   STRIPE_LISTEN_API_URL=... pnpm dev:stripe
//   pnpm dev:stripe -- --api-key sk_test_...   extra flags go to `stripe listen`
//
// The event list comes from STRIPE_WEBHOOK_EVENTS in the billing package, so
// it is always the list that the production endpoint subscribes to.
// `stripe listen` prints its own whsec_ secret: put that value in
// STRIPE_WEBHOOK_SECRET in apps/api/.dev.vars, then restart the API.
// Checkout and webhooks need the Node origin: run `pnpm dev --api-node`.

import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONSTANTS_PATH = path.join(ROOT, "packages/billing/src/providers/stripe/constants.ts");
export const WEBHOOK_PATH = "/billing/webhooks/stripe";
const DEFAULT_API_URL = "http://localhost:8787";

/** Reads the STRIPE_WEBHOOK_EVENTS array from the billing constants source. */
export function readWebhookEvents(source = readFileSync(CONSTANTS_PATH, "utf8")) {
  const match = source.match(/export const STRIPE_WEBHOOK_EVENTS = \[([\s\S]*?)\] as const;/);
  if (!match) throw new Error(`STRIPE_WEBHOOK_EVENTS not found in ${CONSTANTS_PATH}.`);
  const events = [...match[1].matchAll(/"([a-z_.]+)"/g)].map((entry) => entry[1]);
  if (events.length === 0) throw new Error("STRIPE_WEBHOOK_EVENTS is empty.");
  return events;
}

/** The `stripe listen` arguments for one API base URL. */
export function listenArgs(apiUrl, extra = [], events = readWebhookEvents()) {
  const base = new URL(apiUrl);
  if (base.pathname !== "/" || base.search || base.hash) throw new Error(`STRIPE_LISTEN_API_URL "${apiUrl}" must be an origin, such as ${DEFAULT_API_URL}.`);
  return ["listen", "--events", events.join(","), "--forward-to", `${base.origin}${WEBHOOK_PATH}`, ...extra];
}

function main() {
  if (spawnSync("stripe", ["--version"], { stdio: "ignore" }).status !== 0) {
    console.error("[dev:stripe] The Stripe CLI is not installed. Install it (brew install stripe/stripe-cli/stripe), then run `stripe login`.");
    process.exit(1);
  }
  const extra = process.argv.slice(2).filter((arg) => arg !== "--");
  const args = listenArgs(process.env.STRIPE_LISTEN_API_URL || DEFAULT_API_URL, extra);
  console.log(`[dev:stripe] stripe ${args.map((arg) => (arg.includes(",") ? `"${arg}"` : arg)).join(" ")}`);
  console.log("[dev:stripe] Copy the whsec_ secret below into STRIPE_WEBHOOK_SECRET in apps/api/.dev.vars, then restart the API.");
  const child = spawn("stripe", args, { stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("exit", (code, signal) => process.exit(signal ? 0 : (code ?? 1)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
