// The services of a production release and their flip tiers. The flip
// serves one tier at a time, lowest first, and the services of one tier at
// the same time. A service goes after the services it calls, so new code
// calls new code. Services that call one another share a tier
// (scripts/deploy/tests/release.test.mjs checks every service binding against the tiers).
//
// A service with a `target` is staged by `scripts/deploy/release.mjs stage <id>`.
// The others build a config first: the docs-rendering step stages the
// renderer, the dispatcher and the prerenderer
// (apps/docs-template/scripts/deploy-renderer.mjs --stage), and the api step
// stages the edge with the origin (scripts/deploy/deploy-api.mjs --stage).

/**
 * @typedef {import("./wrangler-config.mjs").WranglerTarget} WranglerTarget
 *
 * @typedef {object} ReleaseService
 * @property {number} tier
 * @property {WranglerTarget} [target] the config, for services without a build step of their own
 * @property {string[]} [build] a command that builds the Worker before its upload
 */

/** @type {Readonly<Record<string, ReleaseService>>} */
export const RELEASE_SERVICES = Object.freeze({
  // Tier 1: call no Worker of this release. The agent container runs
  // containers, so it deploys live at its stage step, before every flip.
  "docs-resolver": {
    tier: 1,
    target: { cwd: "apps/api", args: ["--config", "wrangler.docs-resolver.json", "--env", "production"] },
  },
  "try-proxy": { tier: 1, target: { cwd: "apps/try-proxy", args: [] } },
  "agent-container": { tier: 1, target: { cwd: "apps/agent-container", args: ["--env", "production"] } },
  // Tier 2: calls the resolver.
  "search-gateway": { tier: 2, target: { cwd: "apps/search-gateway", args: [] } },
  // Tier 3: the API and the docs Workers that call one another, in a cycle:
  // API -> dispatcher -> shared renderer -> docs runtime -> API.
  "docs-runtime": { tier: 3, target: { cwd: "apps/docs-runtime", args: ["--env", "production"] } },
  "docs-renderer-shared": { tier: 3 },
  "api-edge": { tier: 3 },
  "docs-dispatcher": { tier: 3 },
  "docs-prerenderer": { tier: 3 },
  // Tier 4: the Workers that call the API through its RPC entrypoints.
  "email-worker": { tier: 4, target: { cwd: "apps/email-worker", args: ["--env", "production"] } },
  mcp: { tier: 4, target: { cwd: "apps/mcp", args: ["--env", "production"] } },
  "agent-worker": { tier: 4, target: { cwd: "apps/agent-worker", args: ["--env", "production"] } },
  // Tier 5: the dashboard, which calls the API from the browser.
  web: { tier: 5, target: { cwd: "apps/web", args: [] }, build: ["pnpm", "build:web:release"] },
});

/**
 * @param {string} id
 * @returns {ReleaseService}
 */
export function releaseService(id) {
  const service = RELEASE_SERVICES[id];
  if (!service) throw new Error(`Unknown release service "${id}". Services: ${Object.keys(RELEASE_SERVICES).join(", ")}.`);
  return service;
}
