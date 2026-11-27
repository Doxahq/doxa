import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { validateMcpProductionConfig } from "../lib/mcp-production-config.mjs";

const workspaceRoot = path.resolve(import.meta.dirname, "../../..");
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

// PRODUCTION INCIDENT REGRESSION GUARDRAIL (2026-11-25): doxa-mcp ran without
// billing vars, so its plan checks used the free plan stubs for every project.
// A Pro project that hides "Powered by Doxa" could not build a preview through
// MCP ("entitlement_required" on /branding/poweredBy).
test("sets the billing vars in production, from the ops values", () => {
  const { mcp } = configs();
  const vars = mcp.env.production.vars;
  assert.equal(vars.BILLING_PROVIDER, "none");
  assert.equal(vars.BILLING_ENFORCEMENT, "${OPS_BILLING_ENFORCEMENT}");
  assert.equal(vars.BILLING_DEFAULT_PLAN, "${OPS_BILLING_DEFAULT_PLAN}");
});

test("accepts the filled billing values of a deploy checkout", () => {
  const { mcp, api } = configs();
  Object.assign(mcp.env.production.vars, { BILLING_ENFORCEMENT: "on", BILLING_DEFAULT_PLAN: "free" });

  assert.doesNotThrow(() => validateMcpProductionConfig({ mcp, api }));
});

test("rejects a production config without billing enforcement", () => {
  for (const value of [undefined, "", "enabled"]) {
    const { mcp, api } = configs();
    if (value === undefined) delete mcp.env.production.vars.BILLING_ENFORCEMENT;
    else mcp.env.production.vars.BILLING_ENFORCEMENT = value;

    assert.throws(() => validateMcpProductionConfig({ mcp, api }), /BILLING_ENFORCEMENT/, String(value));
  }
});

test("rejects a payment provider in the MCP Worker", () => {
  for (const value of [undefined, "stripe"]) {
    const { mcp, api } = configs();
    if (value === undefined) delete mcp.env.production.vars.BILLING_PROVIDER;
    else mcp.env.production.vars.BILLING_PROVIDER = value;

    assert.throws(() => validateMcpProductionConfig({ mcp, api }), /BILLING_PROVIDER/, String(value));
  }
});

test("requires the default plan, so provider none does not default to self_hosted", () => {
  for (const value of [undefined, ""]) {
    const { mcp, api } = configs();
    if (value === undefined) delete mcp.env.production.vars.BILLING_DEFAULT_PLAN;
    else mcp.env.production.vars.BILLING_DEFAULT_PLAN = value;

    assert.throws(() => validateMcpProductionConfig({ mcp, api }), /BILLING_DEFAULT_PLAN/, String(value));
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
