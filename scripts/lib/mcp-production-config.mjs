// Production checks for the doxa-mcp Worker (apps/mcp/wrangler.json) and the
// OAuth server settings it needs on doxa-api (apps/api/wrangler.json).

const API_WORKER = "doxa-api-production";
const REQUIRED_SERVICES = [
  ["AUTH_SERVER", "OAuthTokenValidator"],
  ["PLATFORM_ACTIONS", "AgentActionsApi"],
];

/**
 * Throws when the MCP production config would serve the wrong audience, talk
 * to a non-production API, or accept the local-development sign-in bypass.
 */
export function validateMcpProductionConfig({ mcp, api }) {
  const production = mcp?.env?.production;
  if (!production) throw new Error("apps/mcp/wrangler.json must define env.production.");
  const vars = production.vars ?? {};

  // The local sign-in bypass is on at the top level for development. Production
  // turns it off explicitly, which also keeps Wrangler from warning that the
  // var is missing from the env.
  if (vars.MCP_DEV_AUTH_BYPASS !== "false") {
    throw new Error('apps/mcp/wrangler.json env.production.vars.MCP_DEV_AUTH_BYPASS must be "false".');
  }
  for (const [name, value] of Object.entries(vars)) {
    if (typeof value === "string" && /localhost|127\.0\.0\.1/.test(value)) {
      throw new Error(`apps/mcp/wrangler.json env.production.vars.${name} points to ${value}.`);
    }
  }

  const resource = parseHttpsUrl(vars.MCP_RESOURCE_URL, "MCP_RESOURCE_URL");
  parseHttpsUrl(vars.OAUTH_ISSUER, "OAUTH_ISSUER");
  const domains = (production.routes ?? [])
    .filter((route) => route?.custom_domain === true)
    .map((route) => route.pattern);
  if (!domains.includes(resource.hostname)) {
    throw new Error(
      `apps/mcp/wrangler.json env.production.routes must serve ${resource.hostname} as a custom domain (MCP_RESOURCE_URL).`,
    );
  }

  for (const [binding, entrypoint] of REQUIRED_SERVICES) {
    const service = (production.services ?? []).find((candidate) => candidate.binding === binding);
    if (service?.service !== API_WORKER || service.entrypoint !== entrypoint) {
      throw new Error(
        `apps/mcp/wrangler.json env.production.services.${binding} must bind ${API_WORKER} entrypoint ${entrypoint}.`,
      );
    }
  }
  if (!(production.hyperdrive ?? []).some((binding) => binding.binding === "HYPERDRIVE")) {
    throw new Error("apps/mcp/wrangler.json env.production must bind HYPERDRIVE.");
  }

  // Tokens carry the issuer and the resource: both Workers must agree.
  const apiProduction = api?.env?.production ?? {};
  const apiVars = apiProduction.vars ?? {};
  for (const name of ["OAUTH_ISSUER", "MCP_RESOURCE_URL"]) {
    if (apiVars[name] !== vars[name]) {
      throw new Error(
        `env.production.vars.${name} differs: apps/api has ${apiVars[name] ?? "nothing"}, apps/mcp has ${vars[name]}.`,
      );
    }
  }
  if (!(apiProduction.kv_namespaces ?? []).some((binding) => binding.binding === "OAUTH_KV")) {
    throw new Error("apps/api/wrangler.json env.production must bind OAUTH_KV for the MCP sign-in.");
  }
}

function parseHttpsUrl(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`apps/mcp/wrangler.json env.production.vars.${name} must be an https URL.`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`apps/mcp/wrangler.json env.production.vars.${name} must be an https URL.`);
  }
  return url;
}
