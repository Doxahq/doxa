import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { validateMcpProductionConfig } from "./lib/mcp-production-config.mjs";

const workspaceRoot = path.resolve(import.meta.dirname, "..");
const readConfig = (relativePath) =>
  JSON.parse(readFileSync(path.join(workspaceRoot, relativePath), "utf8"));

function configs() {
  return { mcp: readConfig("apps/mcp/wrangler.json"), api: readConfig("apps/api/wrangler.json") };
}

test("accepts the repository's MCP and API production configs", () => {
  assert.doesNotThrow(() => validateMcpProductionConfig(configs()));
});

test("keeps the local sign-in bypass off in production", () => {
  const { mcp, api } = configs();
  assert.equal(mcp.vars.MCP_DEV_AUTH_BYPASS, "true");
  assert.equal(mcp.env.production.vars.MCP_DEV_AUTH_BYPASS, "false");

  for (const value of ["true", "1", undefined]) {
    const candidate = structuredClone(mcp);
    if (value === undefined) delete candidate.env.production.vars.MCP_DEV_AUTH_BYPASS;
    else candidate.env.production.vars.MCP_DEV_AUTH_BYPASS = value;
    assert.throws(() => validateMcpProductionConfig({ mcp: candidate, api }), /MCP_DEV_AUTH_BYPASS/, String(value));
  }
});

test("rejects localhost URLs in production", () => {
  const { mcp, api } = configs();
  mcp.env.production.vars.WEB_ORIGIN = "http://localhost:3001";

  assert.throws(() => validateMcpProductionConfig({ mcp, api }), /WEB_ORIGIN/);
});

test("rejects bindings to the development API Worker", () => {
  const { mcp, api } = configs();
  mcp.env.production.services[0].service = "doxa-api";

  assert.throws(() => validateMcpProductionConfig({ mcp, api }), /AUTH_SERVER/);
});

test("requires the resource host to be the Worker's custom domain", () => {
  const { mcp, api } = configs();
  mcp.env.production.routes = [];

  assert.throws(() => validateMcpProductionConfig({ mcp, api }), /custom domain/);
});

test("requires the API and the MCP Worker to agree on the token audience", () => {
  const { mcp, api } = configs();
  api.env.production.vars.MCP_RESOURCE_URL = "https://other.doxa.so/mcp";

  assert.throws(() => validateMcpProductionConfig({ mcp, api }), /MCP_RESOURCE_URL differs/);
});

test("requires the OAuth KV namespace on the production API", () => {
  const { mcp, api } = configs();
  api.env.production.kv_namespaces = api.env.production.kv_namespaces.filter(
    (binding) => binding.binding !== "OAUTH_KV",
  );

  assert.throws(() => validateMcpProductionConfig({ mcp, api }), /OAUTH_KV/);
});
